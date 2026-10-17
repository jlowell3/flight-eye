import 'package:flutter/services.dart';

/// The few platform calls the shell makes outside the WebView plugin,
/// implemented in `android/app/src/main/kotlin/.../MainActivity.kt`.
///
/// Every call degrades to a harmless default when the channel is missing
/// (tests, or a platform without the native side) so the shell never crashes
/// over a convenience.
abstract final class ShellChannel {
  static const MethodChannel _channel = MethodChannel(
    'com.globodyne.flight_eye/shell',
  );

  /// Version name of the installed WebView provider, e.g. `131.0.6778.39`,
  /// or null when unknown (below Android 8, or no native side).
  static Future<String?> webViewVersion() async {
    try {
      return await _channel.invokeMethod<String>('webViewVersion');
    } on PlatformException {
      return null;
    } on MissingPluginException {
      return null;
    }
  }

  /// Opens [url] outside the app (browser, dialer, Play Store...).
  static Future<bool> openUrl(String url) async {
    try {
      return await _channel.invokeMethod<bool>('openUrl', {'url': url}) ??
          false;
    } on PlatformException {
      return false;
    } on MissingPluginException {
      return false;
    }
  }

  /// Opens the Play Store page of Android System WebView.
  static Future<bool> openWebViewUpdate() async {
    try {
      return await _channel.invokeMethod<bool>('openWebViewUpdate') ?? false;
    } on PlatformException {
      return false;
    } on MissingPluginException {
      return false;
    }
  }
}
