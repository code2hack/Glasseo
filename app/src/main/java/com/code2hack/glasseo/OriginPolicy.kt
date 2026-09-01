package com.code2hack.glasseo

import java.net.URI

object OriginPolicy {
    const val APP_ORIGIN = "https://appassets.androidplatform.net"
    const val START_URL = "$APP_ORIGIN/assets/index.html"

    fun allowsMainFrame(url: String): Boolean = runCatching {
        val uri = URI(url)
        uri.scheme == "https" && uri.host == "appassets.androidplatform.net" && uri.port == -1
    }.getOrDefault(false)
}
