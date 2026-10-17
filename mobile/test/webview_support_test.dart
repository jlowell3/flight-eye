import 'package:flight_eye/config.dart';
import 'package:flight_eye/screens.dart';
import 'package:flight_eye/webview_support.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:webview_flutter/webview_flutter.dart';

void main() {
  group('version parsing', () {
    test('reads the Chrome major from a WebView user agent', () {
      const ua =
          'Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/AP2A.240805.005; wv) '
          'AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 '
          'Chrome/131.0.6778.39 Mobile Safari/537.36';
      expect(parseChromeMajor(ua), 131);
    });

    test('returns null without a Chrome token', () {
      expect(parseChromeMajor('Mozilla/5.0 (Linux) AppleWebKit/537.36'), null);
      expect(parseChromeMajor(null), null);
    });

    test('reads the major from a package version name', () {
      expect(parseVersionMajor('116.0.5845.92'), 116);
      expect(parseVersionMajor(null), null);
      expect(parseVersionMajor('beta'), null);
    });

    test('the minimum matches the AbortSignal.any requirement', () {
      expect(FlightEyeConfig.minChromiumMajor, 116);
    });
  });

  group('origins', () {
    final app = Uri.parse('https://flighteye.example/');

    test('same origin ignores path and case', () {
      expect(
        isSameOrigin(app, Uri.parse('https://FlightEye.example/share?x=1')),
        true,
      );
    });

    test('different scheme, host or port is foreign', () {
      expect(isSameOrigin(app, Uri.parse('http://flighteye.example/')), false);
      expect(
        isSameOrigin(app, Uri.parse('https://flighteye.example:8443/')),
        false,
      );
      expect(isSameOrigin(app, Uri.parse('https://adsb.lol/')), false);
    });

    test('dev origin with an explicit port', () {
      final dev = Uri.parse('http://10.0.2.2:4173/flight-eye.html');
      expect(originMatches(dev, 'http://10.0.2.2:4173'), true);
      expect(originMatches(dev, 'http://10.0.2.2'), false);
      expect(originMatches(dev, 'garbage'), false);
    });

    test('sameDocument ignores fragment and trailing slash', () {
      expect(
        sameDocument(
          'https://flighteye.example/',
          'https://flighteye.example/#cockpit',
        ),
        true,
      );
      expect(
        sameDocument(
          'https://flighteye.example/flight-eye.html',
          'https://flighteye.example/api/flights',
        ),
        false,
      );
      expect(sameDocument(null, 'https://flighteye.example/'), false);
    });
  });

  group('scripts', () {
    test('publishes an escaped app key and the shell marker', () {
      final script = shellGlobalsScript(
        appKey: 'k"ey</script>',
        platform: 'android',
        version: '1.0.0',
      );
      expect(script, contains(r'window.FLIGHT_EYE_APP_KEY = "k\"ey</script>"'));
      expect(
        script,
        contains('window.FLIGHT_EYE_SHELL = {"platform":"android","version":"1.0.0"}'),
      );
      expect(script, contains("'flighteye:shell'"));
    });

    test('back hook result is read from a bool or JSON text', () {
      expect(backHandledByPage(true), true);
      expect(backHandledByPage('true'), true);
      expect(backHandledByPage('"true"'), true);
      expect(backHandledByPage(false), false);
      expect(backHandledByPage('false'), false);
      expect(backHandledByPage('null'), false);
      expect(backHandledByPage(null), false);
    });
  });

  group('failure classification', () {
    test('network errors', () {
      for (final type in [
        WebResourceErrorType.hostLookup,
        WebResourceErrorType.connect,
        WebResourceErrorType.timeout,
      ]) {
        final failure = classifyResourceError(
          WebResourceError(
            errorCode: -2,
            description: 'net::ERR_NAME_NOT_RESOLVED',
            errorType: type,
            isForMainFrame: true,
          ),
        );
        expect(failure.kind, ShellFailureKind.network);
        expect(failure.detail, contains('ERR_NAME_NOT_RESOLVED'));
      }
    });

    test('disconnected by description when the type is unknown', () {
      final failure = classifyResourceError(
        const WebResourceError(
          errorCode: -2,
          description: 'net::ERR_INTERNET_DISCONNECTED',
          errorType: WebResourceErrorType.unknown,
          isForMainFrame: true,
        ),
      );
      expect(failure.kind, ShellFailureKind.network);
    });

    test('tls failure is other', () {
      final failure = classifyResourceError(
        const WebResourceError(
          errorCode: -6,
          description: 'net::ERR_CERT_AUTHORITY_INVALID',
          errorType: WebResourceErrorType.failedSslHandshake,
          isForMainFrame: true,
        ),
      );
      expect(failure.kind, ShellFailureKind.other);
    });

    test('http status', () {
      final failure = classifyHttpStatus(503);
      expect(failure.kind, ShellFailureKind.server);
      expect(failure.detail, 'HTTP 503');
    });
  });

  group('screens', () {
    testWidgets('loading screen shows the title', (tester) async {
      await tester.pumpWidget(
        const MaterialApp(home: LoadingScreen(progress: 40)),
      );
      expect(find.text('FLIGHT EYE'), findsOneWidget);
      expect(find.byType(LinearProgressIndicator), findsOneWidget);
    });

    testWidgets('error screen retries', (tester) async {
      var retried = 0;
      await tester.pumpWidget(
        MaterialApp(
          home: ErrorScreen(
            failure: const ShellFailure(ShellFailureKind.network, 'x'),
            onRetry: () => retried++,
          ),
        ),
      );
      expect(find.text("Can't reach Flight Eye"), findsOneWidget);
      await tester.tap(find.text('Retry'));
      expect(retried, 1);
    });
  });
}
