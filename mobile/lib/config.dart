import 'package:flutter/material.dart';

/// Compile-time configuration of the shell.
///
/// Both values come from `--dart-define` at build time (see mobile/README.md):
///
/// * `FLIGHT_EYE_URL`: the origin the WebView loads. It must be the same
///   origin that serves `/api`, because the server sends no CORS headers and
///   its same-site gate refuses other origins.
/// * `FLIGHT_EYE_APP_KEY`: the abuse-brake key the page sends on the voice
///   routes once the server requires it (plan phase 3). Empty by default.
abstract final class FlightEyeConfig {
  /// Placeholder until the hosted origin exists; override at build time.
  static const String urlString = String.fromEnvironment(
    'FLIGHT_EYE_URL',
    defaultValue: 'https://flighteye.example/',
  );

  static const String appKey = String.fromEnvironment(
    'FLIGHT_EYE_APP_KEY',
    defaultValue: '',
  );

  static final Uri url = Uri.parse(urlString);

  /// Oldest Chromium the web build runs on: `AbortSignal.any` arrived in 116.
  static const int minChromiumMajor = 116;

  /// The web app's page background (`#0a0a0f`), used everywhere a native
  /// surface shows so no frame flashes a lighter colour.
  static const Color background = Color(0xFF0A0A0F);

  /// Accent matching the logo's cyan.
  static const Color accent = Color(0xFF00F6FF);

  static const String appVersion = '1.0.0';
}
