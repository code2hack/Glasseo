package com.code2hack.glasseo

import java.util.concurrent.Executor
import java.util.concurrent.atomic.AtomicBoolean

interface QrFrameLease : AutoCloseable {
    fun read(): QrLuminanceFrame
}

class QrFrameProcessor(
    private val executor: Executor,
    private val decode: (QrLuminanceFrame) -> String?,
    private val onResult: (String) -> Unit,
    private val onError: () -> Unit,
) : AutoCloseable {
    private val busy = AtomicBoolean(false)
    private val complete = AtomicBoolean(false)

    fun submit(frame: QrFrameLease) {
        if (complete.get() || !busy.compareAndSet(false, true)) {
            frame.close()
            return
        }
        executor.execute {
            try {
                val value = decode(frame.read())
                if (value != null && complete.compareAndSet(false, true)) onResult(value)
            } catch (_: Exception) {
                if (complete.compareAndSet(false, true)) onError()
            } finally {
                frame.close()
                busy.set(false)
            }
        }
    }

    override fun close() {
        complete.set(true)
    }
}
