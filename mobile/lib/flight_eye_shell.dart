import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:permission_handler/permission_handler.dart';
import 'package:wakelock_plus/wakelock_plus.dart';
import 'package:webview_flutter/webview_flutter.dart';
import 'package:webview_flutter_android/webview_flutter_android.dart';

import 'config.dart';
import 'screens.dart';
import 'shell_channel.dart';
import 'webview_support.dart';

enum _Phase { loading, ready, failed }

/// The whole app: one WebView on the configured origin, with native loading
/// and error screens around it, OS permission bridging, keep-awake, the
/// back-button contract and the WebView version check.
class FlightEyeShell extends StatefulWidget {
  const FlightEyeShell({super.key});

  @override
  State<FlightEyeShell> createState() => _FlightEyeShellState();
}

class _FlightEyeShellState extends State<FlightEyeShell>
    with WidgetsBindingObserver {
  late final WebViewController _controller;

  _Phase _phase = _Phase.loading;
  ShellFailure? _failure;
  int _progress = 0;
  bool _retrying = false;

  /// URL of the main document currently loading or shown, from
  /// `onPageStarted`; used to tell main-frame HTTP errors from subresources.
  String? _mainFrameUrl;

  /// True while the app is in the foreground; keep-awake follows it.
  bool _foreground = true;

  bool _versionChecked = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _controller = _createController();
    unawaited(_controller.loadRequest(FlightEyeConfig.url));
    WidgetsBinding.instance.addPostFrameCallback((_) {
      unawaited(_checkWebViewVersion());
    });
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    unawaited(WakelockPlus.disable());
    super.dispose();
  }

  // ---------------------------------------------------------------- WebView

  WebViewController _createController() {
    final controller = WebViewController.fromPlatformCreationParams(
      const PlatformWebViewControllerCreationParams(),
      onPermissionRequest: _onPermissionRequest,
    );

    controller
      ..setJavaScriptMode(JavaScriptMode.unrestricted)
      ..setBackgroundColor(FlightEyeConfig.background)
      ..enableZoom(false)
      ..addJavaScriptChannel(
        'FlightEyeShell',
        onMessageReceived: _onShellMessage,
      )
      ..setNavigationDelegate(
        NavigationDelegate(
          onNavigationRequest: _onNavigationRequest,
          onPageStarted: _onPageStarted,
          onProgress: _onProgress,
          onPageFinished: _onPageFinished,
          onWebResourceError: _onWebResourceError,
          onHttpError: _onHttpError,
        ),
      );

    final platform = controller.platform;
    if (platform is AndroidWebViewController) {
      // DOM storage is enabled by the Android implementation when the
      // WebView is created; JavaScript is set above.
      platform
        // The voice session plays remote audio through an autoplaying
        // <audio> element that starts without a tap.
        ..setMediaPlaybackRequiresUserGesture(false)
        ..setGeolocationPermissionsPromptCallbacks(
          onShowPrompt: _onGeolocationPrompt,
          onHidePrompt: () {},
        );
      if (kDebugMode) {
        platform.setOnConsoleMessage((message) {
          debugPrint('[page:${message.level.name}] ${message.message}');
        });
      }
    }
    return controller;
  }

  Future<NavigationDecision> _onNavigationRequest(
    NavigationRequest request,
  ) async {
    final target = Uri.tryParse(request.url);
    if (target == null) return NavigationDecision.navigate;
    final scheme = target.scheme.toLowerCase();
    final isWeb = scheme == 'http' || scheme == 'https';

    // Subframes and anything on our origin stay inside the WebView.
    if (!request.isMainFrame) return NavigationDecision.navigate;
    if (scheme.isEmpty || scheme == 'about' || scheme == 'blob') {
      return NavigationDecision.navigate;
    }
    if (isWeb && isSameOrigin(FlightEyeConfig.url, target)) {
      return NavigationDecision.navigate;
    }

    // External links (attribution, docs) and other schemes (mailto, tel)
    // open outside the app; the shell itself never leaves its origin.
    unawaited(ShellChannel.openUrl(request.url));
    return NavigationDecision.prevent;
  }

  void _onPageStarted(String url) {
    _mainFrameUrl = url;
    _injectShellGlobals();
    if (_phase == _Phase.ready) return;
    setState(() {
      _progress = 0;
    });
  }

  void _onProgress(int progress) {
    if (_phase != _Phase.loading || !mounted) return;
    setState(() => _progress = progress);
  }

  void _onPageFinished(String url) {
    // The page's own scripts may have run before the first injection
    // reached the main frame, so publish the globals again now.
    _injectShellGlobals();
    if (!mounted) return;
    // A failed load also ends with onPageFinished; keep the error screen.
    if (_failure != null) {
      setState(() => _retrying = false);
      return;
    }
    setState(() {
      _phase = _Phase.ready;
      _retrying = false;
      _progress = 100;
    });
    _applyWakelock();
  }

  void _onWebResourceError(WebResourceError error) {
    // Subresource failures (a tile, a feed) are the page's business.
    if (!(error.isForMainFrame ?? true)) return;
    _fail(classifyResourceError(error));
  }

  void _onHttpError(HttpResponseError error) {
    final status = error.response?.statusCode;
    if (status == null || status < 400) return;
    final requestUrl = error.request?.uri.toString();
    final mainFrame =
        sameDocument(requestUrl, _mainFrameUrl) ||
        sameDocument(requestUrl, FlightEyeConfig.urlString);
    if (!mainFrame) return;
    _fail(classifyHttpStatus(status));
  }

  void _fail(ShellFailure failure) {
    if (!mounted) return;
    setState(() {
      _failure = failure;
      _phase = _Phase.failed;
      _retrying = false;
    });
    _applyWakelock();
  }

  Future<void> _retry() async {
    setState(() {
      _retrying = true;
      _failure = null;
      _phase = _Phase.loading;
      _progress = 0;
    });
    await _controller.loadRequest(FlightEyeConfig.url);
  }

  // ------------------------------------------------------ page <-> shell

  void _injectShellGlobals() {
    unawaited(
      _controller
          .runJavaScript(
            shellGlobalsScript(
              appKey: FlightEyeConfig.appKey,
              platform: 'android',
              version: FlightEyeConfig.appVersion,
            ),
          )
          .catchError((Object error) {
            debugPrint('shell globals injection failed: $error');
          }),
    );
  }

  /// Messages from `window.FlightEyeShell.postMessage(...)` in the page.
  void _onShellMessage(JavaScriptMessage message) {
    switch (message.message.trim()) {
      case 'getAppKey':
        _injectShellGlobals();
      case 'ready':
        debugPrint('page reported ready');
      default:
        debugPrint('unknown shell message: ${message.message}');
    }
  }

  // ------------------------------------------------------- permissions

  /// WebRTC permission requests from the page. Only the microphone is
  /// granted, and only after the OS prompt says yes.
  Future<void> _onPermissionRequest(WebViewPermissionRequest request) async {
    final wantsMicOnly =
        request.types.isNotEmpty &&
        request.types.every(
          (type) => type == WebViewPermissionResourceType.microphone,
        );
    if (!wantsMicOnly) {
      await request.deny();
      return;
    }
    final status = await Permission.microphone.request();
    if (status.isGranted) {
      await request.grant();
    } else {
      await request.deny();
    }
  }

  /// `navigator.geolocation` from the page, bridged to the OS prompt.
  Future<GeolocationPermissionsResponse> _onGeolocationPrompt(
    GeolocationPermissionsRequestParams request,
  ) async {
    if (!originMatches(FlightEyeConfig.url, request.origin)) {
      return const GeolocationPermissionsResponse(allow: false, retain: false);
    }
    final status = await Permission.locationWhenInUse.request();
    return GeolocationPermissionsResponse(
      allow: status.isGranted,
      retain: status.isGranted,
    );
  }

  // ------------------------------------------------- lifecycle and system

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    _foreground = state == AppLifecycleState.resumed;
    if (_foreground) {
      // Dialogs and the OS permission sheets can bring the bars back.
      unawaited(SystemChrome.setEnabledSystemUIMode(SystemUiMode.immersiveSticky));
    }
    _applyWakelock();
  }

  /// Screen stays on exactly while the page is visible in the foreground.
  void _applyWakelock() {
    final keepAwake = _foreground && _phase == _Phase.ready;
    unawaited(WakelockPlus.toggle(enable: keepAwake));
  }

  Future<void> _checkWebViewVersion() async {
    if (_versionChecked) return;
    _versionChecked = true;
    int? major;
    try {
      major = parseChromeMajor(await _controller.getUserAgent());
    } catch (error) {
      debugPrint('user agent unavailable: $error');
    }
    major ??= parseVersionMajor(await ShellChannel.webViewVersion());
    if (major == null || major >= FlightEyeConfig.minChromiumMajor) return;
    if (!mounted) return;
    await showDialog<void>(
      context: context,
      builder: (_) => WebViewUpdateDialog(
        installedMajor: major!,
        onUpdate: () async {
          await ShellChannel.openWebViewUpdate();
        },
      ),
    );
  }

  /// Hardware back: the page gets the first say (close a sheet, leave the
  /// cockpit); when it does not claim the press the app exits.
  Future<void> _onBack() async {
    if (_phase == _Phase.ready) {
      try {
        final result = await _controller.runJavaScriptReturningResult(
          backHookScript,
        );
        if (backHandledByPage(result)) return;
      } catch (error) {
        debugPrint('back hook failed: $error');
      }
    }
    await SystemNavigator.pop();
  }

  // ---------------------------------------------------------------- UI

  @override
  Widget build(BuildContext context) {
    final failure = _failure;
    return PopScope(
      canPop: false,
      onPopInvokedWithResult: (didPop, _) {
        if (didPop) return;
        unawaited(_onBack());
      },
      child: ColoredBox(
        color: FlightEyeConfig.background,
        child: Stack(
          fit: StackFit.expand,
          children: [
            // Always mounted so a reload keeps the same WebView and its
            // storage; the native screens cover it while it is not ready.
            WebViewWidget(controller: _controller),
            if (_phase == _Phase.failed && failure != null)
              ErrorScreen(
                failure: failure,
                onRetry: _retry,
                retrying: _retrying,
              )
            else if (_phase != _Phase.ready)
              LoadingScreen(progress: _progress),
          ],
        ),
      ),
    );
  }
}
