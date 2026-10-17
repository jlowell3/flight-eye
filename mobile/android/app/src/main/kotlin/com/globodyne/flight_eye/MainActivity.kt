package com.globodyne.flight_eye

import android.content.ActivityNotFoundException
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.webkit.WebView
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel

/**
 * Hosts the Flutter view and a small method channel for the few things the
 * shell needs from the platform directly: the installed System WebView
 * version (more reliable than the user agent on API 26+) and opening a URL
 * outside the app (external links, the Play Store page for the WebView).
 */
class MainActivity : FlutterActivity() {
    private val channelName = "com.globodyne.flight_eye/shell"
    private val webViewPackage = "com.google.android.webview"

    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, channelName).setMethodCallHandler { call, result ->
            when (call.method) {
                "webViewVersion" -> result.success(webViewVersionName())
                "openUrl" -> {
                    val url = call.argument<String>("url")
                    if (url.isNullOrBlank()) {
                        result.error("bad-args", "url is required", null)
                    } else {
                        result.success(openExternal(url))
                    }
                }
                "openWebViewUpdate" -> {
                    val opened = openExternal("market://details?id=$webViewPackage") ||
                        openExternal("https://play.google.com/store/apps/details?id=$webViewPackage")
                    result.success(opened)
                }
                else -> result.notImplemented()
            }
        }
    }

    /** Version name of the WebView provider, e.g. "131.0.6778.39", or null below API 26. */
    private fun webViewVersionName(): String? {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return null
        return try {
            WebView.getCurrentWebViewPackage()?.versionName
        } catch (_: Exception) {
            null
        }
    }

    private fun openExternal(url: String): Boolean {
        return try {
            val intent = Intent(Intent.ACTION_VIEW, Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            startActivity(intent)
            true
        } catch (_: ActivityNotFoundException) {
            false
        } catch (_: SecurityException) {
            false
        }
    }
}
