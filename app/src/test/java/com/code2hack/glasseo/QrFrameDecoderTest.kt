package com.code2hack.glasseo

import com.google.zxing.BarcodeFormat
import com.google.zxing.qrcode.QRCodeWriter
import java.nio.ByteBuffer
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Test

class QrFrameDecoderTest {
    @Test fun decodesQrOnlyAcrossRightAngleRotations() {
        val value = "https://app.paseo.sh/#offer=fixture"
        val matrix = QRCodeWriter().encode(value, BarcodeFormat.QR_CODE, 128, 128)
        val bytes = ByteArray(matrix.width * matrix.height) { index ->
            if (matrix[index % matrix.width, index / matrix.width]) 0 else 0xff.toByte()
        }
        for (rotation in listOf(0, 90, 180, 270)) {
            assertEquals(value, QrFrameDecoder().decode(QrLuminanceFrame(bytes, matrix.width, matrix.height, rotation)))
        }
        assertNull(QrFrameDecoder().decode(QrLuminanceFrame(ByteArray(400) { 0xff.toByte() }, 20, 20)))
    }

    @Test fun copiesPaddedAndPixelStridedYPlaneWithoutChroma() {
        val bytes = byteArrayOf(1, 9, 2, 9, 3, 8, 8, 4, 9, 5, 9, 6)
        assertArrayEquals(
            byteArrayOf(1, 2, 3, 4, 5, 6),
            QrFrameDecoder.copyYPlane(ByteBuffer.wrap(bytes), 3, 2, 7, 2),
        )
        assertThrows(IllegalArgumentException::class.java) {
            QrFrameDecoder.copyYPlane(ByteBuffer.wrap(byteArrayOf(1)), 2, 2, 2, 1)
        }
        assertThrows(IllegalArgumentException::class.java) {
            QrFrameDecoder.rotate(QrLuminanceFrame(byteArrayOf(1), 1, 1, 45))
        }
        assertArrayEquals(
            byteArrayOf(5, 6, 9, 10),
            QrFrameDecoder.crop(
                QrLuminanceFrame(ByteArray(16) { it.toByte() }, 4, 4),
                1,
                1,
                2,
                2,
            ).bytes,
        )
        assertThrows(IllegalArgumentException::class.java) {
            QrFrameDecoder.crop(QrLuminanceFrame(ByteArray(4), 2, 2), 1, 1, 2, 2)
        }
    }
}
