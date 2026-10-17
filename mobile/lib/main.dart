import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import 'config.dart';
import 'flight_eye_shell.dart';

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  // Immersive: the page gets the whole screen; the bars return on a swipe
  // and hide again by themselves.
  SystemChrome.setEnabledSystemUIMode(SystemUiMode.immersiveSticky);
  SystemChrome.setSystemUIOverlayStyle(
    const SystemUiOverlayStyle(
      statusBarColor: Colors.transparent,
      statusBarIconBrightness: Brightness.light,
      systemNavigationBarColor: Colors.transparent,
      systemNavigationBarIconBrightness: Brightness.light,
      systemNavigationBarContrastEnforced: false,
    ),
  );
  runApp(const FlightEyeApp());
}

class FlightEyeApp extends StatelessWidget {
  const FlightEyeApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Flight Eye',
      debugShowCheckedModeBanner: false,
      theme: ThemeData(
        brightness: Brightness.dark,
        scaffoldBackgroundColor: FlightEyeConfig.background,
        colorScheme: const ColorScheme.dark(
          primary: FlightEyeConfig.accent,
          surface: FlightEyeConfig.background,
        ),
        useMaterial3: true,
      ),
      home: const Scaffold(
        backgroundColor: FlightEyeConfig.background,
        body: FlightEyeShell(),
      ),
    );
  }
}
