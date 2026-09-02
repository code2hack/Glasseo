package com.code2hack.glasseo

import android.annotation.SuppressLint
import android.app.Activity
import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.ImageFormat
import android.graphics.Paint
import android.graphics.SurfaceTexture
import android.hardware.camera2.CameraCaptureSession
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraDevice
import android.hardware.camera2.CameraManager
import android.hardware.camera2.CaptureRequest
import android.media.Image
import android.media.ImageReader
import android.os.Handler
import android.os.HandlerThread
import android.util.Size
import android.view.Surface
import android.view.TextureView
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import java.util.concurrent.Executor
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.math.abs

class QrCameraSession(
    private val activity: Activity,
    private val root: FrameLayout,
    private val onResult: (String) -> Unit,
    private val onError: (QrScannerErrorCode) -> Unit,
    private val trace: (String) -> Unit,
) : QrScannerSession {
    private val closed = AtomicBoolean(false)
    private val cameraThread = HandlerThread("glasseo-qr-camera").apply { start() }
    private val cameraHandler = Handler(cameraThread.looper)
    private val decoder = QrFrameDecoder()
    private val processor = QrFrameProcessor(
        Executor { it.run() },
        decoder::decode,
        { activity.runOnUiThread { if (!closed.get()) onResult(it) } },
        { activity.runOnUiThread { if (!closed.get()) onError(QrScannerErrorCode.DECODE_ERROR) } },
    )
    private val overlay = FrameLayout(activity)
    private val preview = TextureView(activity)
    private var camera: CameraDevice? = null
    private var captureSession: CameraCaptureSession? = null
    private var imageReader: ImageReader? = null
    private var previewSurface: Surface? = null

    init {
        overlay.setBackgroundColor(Color.BLACK)
        overlay.addView(preview, matchParent())
        overlay.addView(ScanFrameView(activity), matchParent())
        root.addView(overlay, matchParent())
        preview.surfaceTextureListener = object : TextureView.SurfaceTextureListener {
            override fun onSurfaceTextureAvailable(surface: SurfaceTexture, width: Int, height: Int) = open(surface)
            override fun onSurfaceTextureSizeChanged(surface: SurfaceTexture, width: Int, height: Int) = Unit
            override fun onSurfaceTextureDestroyed(surface: SurfaceTexture): Boolean {
                if (!closed.get()) onError(QrScannerErrorCode.CAMERA_UNAVAILABLE)
                return true
            }
            override fun onSurfaceTextureUpdated(surface: SurfaceTexture) = Unit
        }
        if (preview.isAvailable) open(checkNotNull(preview.surfaceTexture))
    }

    @SuppressLint("MissingPermission")
    private fun open(texture: SurfaceTexture) {
        if (closed.get() || camera != null) return
        try {
            val manager = activity.getSystemService(CameraManager::class.java)
            val selection = selectCamera(manager)
            texture.setDefaultBufferSize(selection.preview.width, selection.preview.height)
            previewSurface = Surface(texture)
            imageReader = ImageReader.newInstance(
                selection.yuv.width,
                selection.yuv.height,
                ImageFormat.YUV_420_888,
                2,
            ).also { reader ->
                reader.setOnImageAvailableListener({ submit(it.acquireLatestImage(), selection.rotation) }, cameraHandler)
            }
            trace("cameraId=${selection.id} size=${selection.yuv.width}x${selection.yuv.height}")
            manager.openCamera(selection.id, object : CameraDevice.StateCallback() {
                override fun onOpened(device: CameraDevice) {
                    if (closed.get()) device.close() else {
                        camera = device
                        createCaptureSession(device)
                    }
                }
                override fun onDisconnected(device: CameraDevice) {
                    device.close()
                    fail()
                }
                override fun onError(device: CameraDevice, error: Int) {
                    device.close()
                    fail()
                }
            }, cameraHandler)
        } catch (_: Exception) {
            fail()
        }
    }

    private fun createCaptureSession(device: CameraDevice) {
        val preview = previewSurface ?: return fail()
        val reader = imageReader ?: return fail()
        device.createCaptureSession(listOf(preview, reader.surface), object : CameraCaptureSession.StateCallback() {
            override fun onConfigured(session: CameraCaptureSession) {
                if (closed.get()) return session.close()
                captureSession = session
                val request = device.createCaptureRequest(CameraDevice.TEMPLATE_PREVIEW).apply {
                    addTarget(preview)
                    addTarget(reader.surface)
                    set(CaptureRequest.CONTROL_AF_MODE, CaptureRequest.CONTROL_AF_MODE_CONTINUOUS_PICTURE)
                }.build()
                runCatching { session.setRepeatingRequest(request, null, cameraHandler) }
                    .onFailure { fail() }
            }
            override fun onConfigureFailed(session: CameraCaptureSession) = fail()
        }, cameraHandler)
    }

    private fun submit(image: Image?, rotation: Int) {
        if (image == null) return
        processor.submit(object : QrFrameLease {
            override fun read(): QrLuminanceFrame {
                val plane = image.planes[0]
                return QrLuminanceFrame(
                    QrFrameDecoder.copyYPlane(
                        plane.buffer,
                        image.width,
                        image.height,
                        plane.rowStride,
                        plane.pixelStride,
                    ),
                    image.width,
                    image.height,
                    rotation,
                )
            }
            override fun close() = image.close()
        })
    }

    private fun fail() {
        overlay.post { if (!closed.get()) onError(QrScannerErrorCode.CAMERA_UNAVAILABLE) }
    }

    override fun close() {
        if (!closed.compareAndSet(false, true)) return
        processor.close()
        captureSession?.close()
        captureSession = null
        camera?.close()
        camera = null
        imageReader?.close()
        imageReader = null
        previewSurface?.release()
        previewSurface = null
        cameraThread.quitSafely()
        activity.runOnUiThread { root.removeView(overlay) }
    }

    private fun selectCamera(manager: CameraManager): Selection {
        val candidates = manager.cameraIdList.mapNotNull { id ->
            val details = manager.getCameraCharacteristics(id)
            val config = details.get(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP) ?: return@mapNotNull null
            val yuv = config.getOutputSizes(ImageFormat.YUV_420_888)?.minByOrNull(::sizeDistance)
                ?: return@mapNotNull null
            val preview = config.getOutputSizes(SurfaceTexture::class.java)?.minByOrNull(::sizeDistance)
                ?: return@mapNotNull null
            val capabilities = details.get(CameraCharacteristics.REQUEST_AVAILABLE_CAPABILITIES)?.toSet().orEmpty()
            if (CameraCharacteristics.REQUEST_AVAILABLE_CAPABILITIES_BACKWARD_COMPATIBLE !in capabilities) return@mapNotNull null
            Selection(id, yuv, preview, details.get(CameraCharacteristics.SENSOR_ORIENTATION) ?: 0)
        }
        return candidates.minByOrNull { sizeDistance(it.yuv) }
            ?: error("No color preview/YUV camera")
    }

    private fun sizeDistance(size: Size): Int = abs(size.width - 640) + abs(size.height - 480)

    private data class Selection(val id: String, val yuv: Size, val preview: Size, val rotation: Int)

    private fun matchParent() = FrameLayout.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT,
        ViewGroup.LayoutParams.MATCH_PARENT,
    )
}

private class ScanFrameView(context: Context) : View(context) {
    private val paint = Paint().apply {
        color = Color.WHITE
        style = Paint.Style.STROKE
        strokeWidth = 4f
    }

    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        val side = minOf(width, height) * 0.7f
        canvas.drawRect((width - side) / 2, (height - side) / 2, (width + side) / 2, (height + side) / 2, paint)
    }
}
