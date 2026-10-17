import 'package:flutter/material.dart';

import 'config.dart';
import 'webview_support.dart';

/// Native loading screen shown until the page's first load completes.
class LoadingScreen extends StatelessWidget {
  const LoadingScreen({super.key, required this.progress});

  /// Page load progress, 0 to 100.
  final int progress;

  @override
  Widget build(BuildContext context) {
    return ColoredBox(
      color: FlightEyeConfig.background,
      child: SafeArea(
        child: Center(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              const _Logo(width: 180),
              const SizedBox(height: 28),
              const _Title(),
              const SizedBox(height: 36),
              SizedBox(
                width: 160,
                child: LinearProgressIndicator(
                  // Indeterminate until the WebView reports real progress.
                  value: progress <= 0 || progress >= 100
                      ? null
                      : progress / 100,
                  minHeight: 3,
                  color: FlightEyeConfig.accent,
                  backgroundColor: Colors.white12,
                ),
              ),
              const SizedBox(height: 16),
              Text(
                'Connecting',
                style: Theme.of(
                  context,
                ).textTheme.bodySmall?.copyWith(color: Colors.white54),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// Native offline / error screen with a Retry action.
class ErrorScreen extends StatelessWidget {
  const ErrorScreen({
    super.key,
    required this.failure,
    required this.onRetry,
    this.retrying = false,
  });

  final ShellFailure failure;
  final VoidCallback onRetry;

  /// True while a retry is in flight; the button shows a spinner.
  final bool retrying;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final icon = switch (failure.kind) {
      ShellFailureKind.network => Icons.cloud_off_rounded,
      ShellFailureKind.server => Icons.dns_rounded,
      ShellFailureKind.other => Icons.error_outline_rounded,
    };
    return ColoredBox(
      color: FlightEyeConfig.background,
      child: SafeArea(
        child: Center(
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 32),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                const _Logo(width: 120),
                const SizedBox(height: 32),
                Icon(icon, size: 40, color: Colors.white70),
                const SizedBox(height: 16),
                Text(
                  failure.title,
                  textAlign: TextAlign.center,
                  style: theme.textTheme.titleLarge?.copyWith(
                    color: Colors.white,
                    fontWeight: FontWeight.w600,
                  ),
                ),
                const SizedBox(height: 10),
                Text(
                  failure.message,
                  textAlign: TextAlign.center,
                  style: theme.textTheme.bodyMedium?.copyWith(
                    color: Colors.white70,
                  ),
                ),
                const SizedBox(height: 28),
                FilledButton.icon(
                  onPressed: retrying ? null : onRetry,
                  style: FilledButton.styleFrom(
                    backgroundColor: FlightEyeConfig.accent,
                    foregroundColor: FlightEyeConfig.background,
                    padding: const EdgeInsets.symmetric(
                      horizontal: 28,
                      vertical: 14,
                    ),
                  ),
                  icon: retrying
                      ? const SizedBox(
                          width: 16,
                          height: 16,
                          child: CircularProgressIndicator(strokeWidth: 2),
                        )
                      : const Icon(Icons.refresh_rounded),
                  label: Text(retrying ? 'Retrying' : 'Retry'),
                ),
                const SizedBox(height: 28),
                Text(
                  '${failure.detail}\n${FlightEyeConfig.url.host}',
                  textAlign: TextAlign.center,
                  style: theme.textTheme.bodySmall?.copyWith(
                    color: Colors.white38,
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// Prompt shown when the installed Android System WebView is older than the
/// Chromium the web build needs.
class WebViewUpdateDialog extends StatelessWidget {
  const WebViewUpdateDialog({
    super.key,
    required this.installedMajor,
    required this.onUpdate,
  });

  final int installedMajor;
  final Future<void> Function() onUpdate;

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      backgroundColor: const Color(0xFF14141C),
      title: const Text('Update Android System WebView'),
      content: Text(
        'Flight Eye needs Android System WebView version '
        '${FlightEyeConfig.minChromiumMajor} or newer. This phone has '
        'version $installedMajor, so parts of the app may not work.\n\n'
        'Update it from the Play Store, then open Flight Eye again.',
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.of(context).pop(),
          child: const Text('Not now'),
        ),
        FilledButton(
          onPressed: () async {
            await onUpdate();
            if (context.mounted) Navigator.of(context).pop();
          },
          child: const Text('Update'),
        ),
      ],
    );
  }
}

class _Logo extends StatelessWidget {
  const _Logo({required this.width});

  final double width;

  @override
  Widget build(BuildContext context) {
    return Image.asset(
      'assets/logo.png',
      width: width,
      filterQuality: FilterQuality.medium,
      excludeFromSemantics: true,
    );
  }
}

class _Title extends StatelessWidget {
  const _Title();

  @override
  Widget build(BuildContext context) {
    return Text(
      'FLIGHT EYE',
      style: Theme.of(context).textTheme.titleMedium?.copyWith(
        color: Colors.white,
        letterSpacing: 6,
        fontWeight: FontWeight.w600,
      ),
    );
  }
}
