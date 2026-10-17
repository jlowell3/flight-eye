import 'dart:convert';

import 'package:webview_flutter/webview_flutter.dart';

/// Pure helpers behind the shell: version parsing, error classification,
/// origin checks and the scripts injected into the page. Kept free of
/// platform calls so they are unit-testable.

/// Major Chromium version from a WebView user agent
/// (`... Chrome/131.0.6778.39 Mobile Safari/537.36`), or null when the user
/// agent carries no Chrome token.
int? parseChromeMajor(String? userAgent) {
  if (userAgent == null) return null;
  final match = RegExp(r'\bChrome/(\d+)').firstMatch(userAgent);
  return match == null ? null : int.tryParse(match.group(1)!);
}

/// Major component of a dotted version name such as `131.0.6778.39`.
int? parseVersionMajor(String? versionName) {
  if (versionName == null) return null;
  final match = RegExp(r'^\s*(\d+)').firstMatch(versionName);
  return match == null ? null : int.tryParse(match.group(1)!);
}

/// Whether [candidate] is on the same origin (scheme, host, port) as [app].
bool isSameOrigin(Uri app, Uri candidate) {
  return candidate.scheme == app.scheme &&
      candidate.host.toLowerCase() == app.host.toLowerCase() &&
      candidate.port == app.port;
}

/// Whether a WebView origin string (`https://host:port`, as handed to the
/// geolocation prompt) names the app's origin.
bool originMatches(Uri app, String origin) {
  final parsed = Uri.tryParse(origin.trim());
  if (parsed == null || parsed.host.isEmpty) return false;
  return isSameOrigin(app, parsed);
}

/// Script run at page load: publishes the app key and a shell marker on
/// `window`, then announces them so a page that loaded first can react.
/// See the "Page contract" section of mobile/README.md.
String shellGlobalsScript({
  required String appKey,
  required String platform,
  required String version,
}) {
  final key = jsonEncode(appKey);
  final shell = jsonEncode({'platform': platform, 'version': version});
  return '''
(function () {
  window.FLIGHT_EYE_APP_KEY = $key;
  window.FLIGHT_EYE_SHELL = $shell;
  try {
    window.dispatchEvent(new CustomEvent('flighteye:shell', { detail: window.FLIGHT_EYE_SHELL }));
  } catch (e) {}
})();
''';
}

/// Script run on the hardware back button. Returns `true` when the page
/// consumed the press (closed a sheet, left the cockpit...), anything else
/// when the shell should exit.
const String backHookScript = '''
(function () {
  try {
    return typeof window.flightEyeBack === 'function' && window.flightEyeBack() === true;
  } catch (e) {
    return false;
  }
})();
''';

/// Interprets the value `runJavaScriptReturningResult` hands back for
/// [backHookScript]: Android returns JSON text, other platforms a bool.
bool backHandledByPage(Object? result) {
  if (result is bool) return result;
  if (result is String) {
    final text = result.trim();
    return text == 'true' || text == '"true"';
  }
  return false;
}

/// Why the page could not be shown, for the native error screen.
enum ShellFailureKind {
  /// No route to the server: offline, DNS failure, timeout, refused.
  network,

  /// The server answered with an HTTP error status.
  server,

  /// Anything else (TLS failure, bad URL, renderer crash).
  other,
}

class ShellFailure {
  const ShellFailure(this.kind, this.detail);

  final ShellFailureKind kind;

  /// Short technical detail shown in small print (error code or status).
  final String detail;

  String get title => switch (kind) {
    ShellFailureKind.network => "Can't reach Flight Eye",
    ShellFailureKind.server => 'Flight Eye is having trouble',
    ShellFailureKind.other => "Flight Eye couldn't load",
  };

  String get message => switch (kind) {
    ShellFailureKind.network =>
      'Check that this phone is online, then try again.',
    ShellFailureKind.server =>
      'The server answered with an error. Try again in a moment.',
    ShellFailureKind.other => 'Something went wrong while loading the app.',
  };
}

/// Classifies a main-frame resource error.
ShellFailure classifyResourceError(WebResourceError error) {
  final description = error.description;
  final detail = description.isEmpty
      ? 'error ${error.errorCode}'
      : '$description (${error.errorCode})';
  switch (error.errorType) {
    case WebResourceErrorType.hostLookup:
    case WebResourceErrorType.connect:
    case WebResourceErrorType.timeout:
    case WebResourceErrorType.io:
    case WebResourceErrorType.proxyAuthentication:
      return ShellFailure(ShellFailureKind.network, detail);
    default:
      if (description.contains('INTERNET_DISCONNECTED') ||
          description.contains('NETWORK_CHANGED') ||
          description.contains('ADDRESS_UNREACHABLE')) {
        return ShellFailure(ShellFailureKind.network, detail);
      }
      return ShellFailure(ShellFailureKind.other, detail);
  }
}

/// Classifies a main-frame HTTP error status.
ShellFailure classifyHttpStatus(int statusCode) {
  return ShellFailure(ShellFailureKind.server, 'HTTP $statusCode');
}

/// Same document, ignoring the fragment and a trailing slash, so a main-frame
/// request can be matched against the URL `onPageStarted` reported.
bool sameDocument(String? a, String? b) {
  if (a == null || b == null) return false;
  String norm(String s) {
    final u = Uri.tryParse(s);
    if (u == null) return s;
    final path = u.path.endsWith('/') && u.path.length > 1
        ? u.path.substring(0, u.path.length - 1)
        : u.path;
    return u.replace(fragment: '', path: path).toString().replaceFirst(
      RegExp(r'#$'),
      '',
    );
  }

  return norm(a) == norm(b);
}
