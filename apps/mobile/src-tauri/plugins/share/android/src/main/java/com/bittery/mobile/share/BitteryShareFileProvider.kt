package com.bittery.mobile.share

import androidx.core.content.FileProvider

/**
 * An empty `FileProvider` subclass that exists purely to carry a distinct class name.
 *
 * Tauri's generated app manifest already declares `androidx.core.content.FileProvider` (authority
 * `${applicationId}.fileprovider`, paths `@xml/file_paths`) for `RustWebChromeClient`'s file-input
 * capture. The manifest merger keys `<provider>` elements by `android:name`, so a second element
 * with the same class is treated as the *same* provider and the build fails on the conflicting
 * `android:authorities` and `android:resource` values — not something `tools:replace` can fix,
 * since both providers are real and both must survive.
 *
 * Subclassing gives this plugin's provider its own name, so the two merge as separate entries.
 * Behaviour is unchanged: `FileProvider.getUriForFile` resolves by authority and reads the
 * `FILE_PROVIDER_PATHS` meta-data off whichever component declares it.
 */
class BitteryShareFileProvider : FileProvider()
