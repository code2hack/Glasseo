package com.code2hack.glasseo

import com.google.zxing.BarcodeFormat
import com.google.zxing.BinaryBitmap
import com.google.zxing.DecodeHintType
import com.google.zxing.MultiFormatReader
import com.google.zxing.PlanarYUVLuminanceSource
import com.google.zxing.common.HybridBinarizer
import java.nio.ByteBuffer

data class QrLuminanceFrame(
    val bytes: ByteArray,
    val width: Int,
    val height: Int,
    val rotationDegrees: Int = 0,
)

class QrFrameDecoder {
    private val reader = MultiFormatReader().apply {
        setHints(mapOf(DecodeHintType.POSSIBLE_FORMATS to listOf(BarcodeFormat.QR_CODE)))
    }

    fun decode(frame: QrLuminanceFrame): String? {
        val rotated = rotate(frame)
        val source = PlanarYUVLuminanceSource(
            rotated.bytes,
            rotated.width,
            rotated.height,
            0,
            0,
            rotated.width,
            rotated.height,
            false,
        )
        return runCatching { reader.decodeWithState(BinaryBitmap(HybridBinarizer(source))).text }
            .getOrNull()
            .also { reader.reset() }
    }

    companion object {
        fun copyYPlane(
            buffer: ByteBuffer,
            width: Int,
            height: Int,
            rowStride: Int,
            pixelStride: Int,
        ): ByteArray {
            require(width > 0 && height > 0 && rowStride >= width && pixelStride > 0)
            require((height - 1L) * rowStride + (width - 1L) * pixelStride < buffer.limit())
            val source = buffer.duplicate()
            return ByteArray(width * height) { index ->
                val y = index / width
                val x = index % width
                source.get(y * rowStride + x * pixelStride)
            }
        }

        fun rotate(frame: QrLuminanceFrame): QrLuminanceFrame {
            require(frame.bytes.size == frame.width * frame.height)
            val rotation = ((frame.rotationDegrees % 360) + 360) % 360
            require(rotation % 90 == 0)
            if (rotation == 0) return frame
            val output = ByteArray(frame.bytes.size)
            val newWidth = if (rotation == 180) frame.width else frame.height
            val newHeight = if (rotation == 180) frame.height else frame.width
            for (y in 0 until frame.height) for (x in 0 until frame.width) {
                val target = when (rotation) {
                    90 -> x * newWidth + (newWidth - 1 - y)
                    180 -> (newHeight - 1 - y) * newWidth + (newWidth - 1 - x)
                    else -> (newHeight - 1 - x) * newWidth + y
                }
                output[target] = frame.bytes[y * frame.width + x]
            }
            return QrLuminanceFrame(output, newWidth, newHeight)
        }

        fun crop(frame: QrLuminanceFrame, left: Int, top: Int, width: Int, height: Int): QrLuminanceFrame {
            require(left >= 0 && top >= 0 && width > 0 && height > 0)
            require(left + width <= frame.width && top + height <= frame.height)
            val output = ByteArray(width * height)
            for (row in 0 until height) {
                frame.bytes.copyInto(
                    output,
                    row * width,
                    (top + row) * frame.width + left,
                    (top + row) * frame.width + left + width,
                )
            }
            return QrLuminanceFrame(output, width, height, frame.rotationDegrees)
        }
    }
}
