package com.code2hack.glasseo

import java.util.concurrent.Executor
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class QrFrameProcessorTest {
    @Test fun appliesBackpressureClosesEveryFrameAndEmitsOneResult() {
        val executor = ManualExecutor()
        val values = mutableListOf<String>()
        val first = FakeFrame()
        val skipped = FakeFrame()
        val late = FakeFrame()
        val processor = QrFrameProcessor(executor, { "decoded" }, values::add, {})

        processor.submit(first)
        processor.submit(skipped)
        assertTrue(skipped.closed)
        executor.runNext()
        assertTrue(first.closed)
        assertEquals(listOf("decoded"), values)
        processor.submit(late)
        assertTrue(late.closed)
        assertEquals(1, executor.tasks.size)
    }

    @Test fun decodingFailureClosesFrameAndEmitsBoundedError() {
        val executor = ManualExecutor()
        var errors = 0
        val frame = FakeFrame()
        val processor = QrFrameProcessor(executor, { error("private decoder detail") }, {}, { errors++ })
        processor.submit(frame)
        executor.runNext()
        assertTrue(frame.closed)
        assertEquals(1, errors)
    }

    private class ManualExecutor : Executor {
        val tasks = mutableListOf<Runnable>()
        override fun execute(command: Runnable) { tasks += command }
        fun runNext() = tasks.first { it !is Completed }.also { it.run(); tasks[tasks.indexOf(it)] = Completed }
        private object Completed : Runnable { override fun run() = Unit }
    }

    private class FakeFrame : QrFrameLease {
        var closed = false
        override fun read() = QrLuminanceFrame(byteArrayOf(0), 1, 1)
        override fun close() { closed = true }
    }
}
