package com.bittery.mobile.share

import android.app.Activity
import android.content.Intent
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.Plugin

/**
 * Wraps Android's `ACTION_SEND` text share, the equivalent of React Native's
 * `Share.share({ message, title })` that `apps/mobile`'s `ShareItemSheet` used to hand a
 * freshly created share-link URL to another app.
 *
 * `Intent.createChooser` is used unconditionally rather than `startActivity` directly:
 * without it, a device with exactly one app willing to handle `text/plain` (rare, but it
 * happens with some launchers' "share to clipboard" shims) skips the picker and the user
 * never sees what they are about to share to.
 */
@TauriPlugin
class SharePlugin(private val activity: Activity) : Plugin(activity) {

	@InvokeArg
	class ShareTextArgs {
		lateinit var text: String
		var title: String? = null
	}

	@Command
	fun shareText(invoke: Invoke) {
		val args = invoke.parseArgs(ShareTextArgs::class.java)
		try {
			val sendIntent = Intent(Intent.ACTION_SEND).apply {
				type = "text/plain"
				putExtra(Intent.EXTRA_TEXT, args.text)
				args.title?.let { putExtra(Intent.EXTRA_TITLE, it) }
			}
			val chooser = Intent.createChooser(sendIntent, args.title).apply {
				addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
			}
			activity.startActivity(chooser)
			invoke.resolve()
		} catch (cause: Throwable) {
			invoke.reject("shareText failed: ${cause.javaClass.simpleName}: ${cause.message}")
		}
	}
}
