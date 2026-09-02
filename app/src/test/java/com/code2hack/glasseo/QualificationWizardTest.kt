package com.code2hack.glasseo

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class QualificationWizardTest {
    private val primary = HidPhysicalIdentity("keyboard", 1, 2, 66, 28)
    private val other = primary.copy(keyCode = 67, scanCode = 14)

    @Test fun matchingPairAdvancesAndMismatchClearsCandidate() {
        val wizard = QualificationWizard(QualificationMode.HID)
        val operation = hid(primary, BehaviorClass.SHORT)

        assertEquals("Press the button you wanna bind", wizard.state.prompt)
        wizard.capture(operation)
        assertEquals("Press the same button again", wizard.state.prompt)

        wizard.capture(hid(other, BehaviorClass.SHORT))
        assertEquals("Two operations must be the same, try again", wizard.state.error)
        assertFalse(wizard.state.awaitingConfirmation)

        wizard.capture(operation)
        wizard.capture(operation)
        assertEquals(QualificationStep.LONG_PRIMARY, wizard.state.step)
        assertEquals(primary, wizard.bindings.identityFor(SemanticControl.PRIMARY))
    }

    @Test fun verificationStepsRequireTheAlreadyBoundKeyAndWizardProducesSevenBindings() {
        val wizard = QualificationWizard(QualificationMode.HID)
        complete(wizard, primary, BehaviorClass.SHORT)

        wizard.capture(hid(other, BehaviorClass.LONG))
        assertEquals("Use the same PRIMARY button", wizard.state.error)
        complete(wizard, primary, BehaviorClass.LONG)

        val identities = (1..6).map { primary.copy(keyCode = 70 + it, scanCode = 30 + it) }
        complete(wizard, identities[0], BehaviorClass.LONG)
        complete(wizard, identities[0], BehaviorClass.DOUBLE)
        complete(wizard, identities[1], BehaviorClass.SHORT)
        complete(wizard, identities[1], BehaviorClass.LONG)
        identities.drop(2).forEach { complete(wizard, it, BehaviorClass.DIRECTIONAL) }

        assertTrue(wizard.state.complete)
        assertEquals(7, wizard.bindings.size)
    }

    @Test fun duplicatePhysicalAssignmentIsRejected() {
        val wizard = QualificationWizard(QualificationMode.HID)
        complete(wizard, primary, BehaviorClass.SHORT)
        complete(wizard, primary, BehaviorClass.LONG)

        wizard.capture(hid(primary, BehaviorClass.LONG))
        assertEquals("Button is already bound to PRIMARY", wizard.state.error)
        assertFalse(wizard.state.awaitingConfirmation)
    }

    @Test fun longCommandCheckpointResumesAtTheSameAttempt() {
        val completed = OperationResult(
            QualificationStep.SHORT_COMMAND,
            OperationVerdict.PASS,
            SuppressionOutcome.SUCCEEDED,
        )
        val checkpoint = QualificationCheckpoint(
            QualificationMode.BUILT_IN,
            5,
            false,
            mapOf(completed.step to completed),
        )
        val restored = QualificationCheckpoint.decode(checkpoint.encode())
        val wizard = QualificationWizard(restored.mode, startIndex = restored.stepIndex, initialResults = restored.results)

        assertEquals(QualificationStep.LONG_COMMAND, restored.step)
        assertFalse(restored.awaitingConfirmation)
        assertEquals(completed, wizard.results[QualificationStep.SHORT_COMMAND])
    }

    @Test fun lifecycleCancellationClearsThePendingConfirmation() {
        val wizard = QualificationWizard(QualificationMode.HID)
        wizard.capture(hid(primary, BehaviorClass.SHORT))
        assertTrue(wizard.state.awaitingConfirmation)

        wizard.cancelAttempt()
        assertFalse(wizard.state.awaitingConfirmation)
        assertEquals("Input cancelled", wizard.state.error)
    }

    @Test fun operationMatrixDerivesTheSevenControlCapabilityMatrix() {
        val results = QualificationStep.entries.associateWith {
            OperationResult(
                it,
                if (it == QualificationStep.LEFT) OperationVerdict.UNAVAILABLE else OperationVerdict.PASS,
                if (it == QualificationStep.LONG_PRIMARY) SuppressionOutcome.SUCCEEDED else SuppressionOutcome.NOT_NEEDED,
            )
        }
        val capabilities = deriveCapabilities(results)

        assertEquals(BuiltInCapability.AVAILABLE_WITH_SUPPRESSION, capabilities[SemanticControl.PRIMARY])
        assertEquals(BuiltInCapability.UNAVAILABLE_BUILTIN, capabilities[SemanticControl.LEFT])
        assertEquals(BuiltInCapability.AVAILABLE_SAFE, capabilities[SemanticControl.SECONDARY])
    }

    private fun complete(wizard: QualificationWizard, identity: HidPhysicalIdentity, behavior: BehaviorClass) {
        val operation = hid(identity, behavior)
        wizard.capture(operation)
        wizard.capture(operation)
    }

    private fun hid(identity: HidPhysicalIdentity, behavior: BehaviorClass) =
        QualificationOperation(HidOperationSignature(identity, behavior))
}
