import Testing
import Foundation
@testable import ClaudeRemote

@Suite("TriggerWordDetector – Trigger Word Detection")
struct TriggerWordDetectorTests {

    // MARK: - extractCommandAfterTrigger

    @Test("detects 'titus' and extracts command after it")
    func titusExact() {
        let result = TriggerWordDetector.extractCommandAfterTrigger("titus show me the logs")
        #expect(result == "show me the logs")
    }

    @Test("'tightest' no longer triggers (removed — false positive)")
    func tightestRemoved() {
        let result = TriggerWordDetector.extractCommandAfterTrigger("tightest check the status")
        #expect(result == nil)
    }

    @Test("detects 'tidus' variant and extracts command")
    func tidusVariant() {
        let result = TriggerWordDetector.extractCommandAfterTrigger("tidus run the tests")
        #expect(result == "run the tests")
    }

    @Test("detects 'tidas' variant and extracts command")
    func tidasVariant() {
        let result = TriggerWordDetector.extractCommandAfterTrigger("tidas list files")
        #expect(result == "list files")
    }

    @Test("detects 'titis' variant and extracts command")
    func titisVariant() {
        let result = TriggerWordDetector.extractCommandAfterTrigger("titis deploy now")
        #expect(result == "deploy now")
    }

    @Test("'tight us' no longer triggers (removed — false positive)")
    func tightUsRemoved() {
        let result = TriggerWordDetector.extractCommandAfterTrigger("tight us build the project")
        #expect(result == nil)
    }

    @Test("returns empty string when trigger is at end of text")
    func triggerAtEnd() {
        let result = TriggerWordDetector.extractCommandAfterTrigger("hey titus")
        #expect(result == "")
    }

    @Test("returns nil when no trigger word found")
    func noTrigger() {
        let result = TriggerWordDetector.extractCommandAfterTrigger("hello world")
        #expect(result == nil)
    }

    @Test("case insensitive detection — all lowercase input")
    func lowercaseInput() {
        let result = TriggerWordDetector.extractCommandAfterTrigger("titus do something")
        #expect(result == "do something")
    }

    @Test("preserves original casing of extracted command")
    func preservesCasing() {
        let result = TriggerWordDetector.extractCommandAfterTrigger("Titus Show Me The Logs")
        #expect(result == "Show Me The Logs")
    }

    @Test("trigger word in middle of text extracts text after it")
    func triggerInMiddle() {
        let result = TriggerWordDetector.extractCommandAfterTrigger("hey titus what is the weather")
        #expect(result == "what is the weather")
    }

    @Test("trims whitespace from extracted command")
    func trimsWhitespace() {
        let result = TriggerWordDetector.extractCommandAfterTrigger("titus   hello   ")
        #expect(result == "hello")
    }

    @Test("empty text returns nil")
    func emptyText() {
        let result = TriggerWordDetector.extractCommandAfterTrigger("")
        #expect(result == nil)
    }

    // MARK: - isCancelCommand

    @Test("'cancel' is a cancel command")
    func cancelIsCancel() {
        #expect(TriggerWordDetector.isCancelCommand("cancel") == true)
    }

    @Test("'stop' is a cancel command")
    func stopIsCancel() {
        #expect(TriggerWordDetector.isCancelCommand("stop") == true)
    }

    @Test("'cancel that' is a cancel command (first word match)")
    func cancelThatIsCancel() {
        #expect(TriggerWordDetector.isCancelCommand("cancel that") == true)
    }

    @Test("'stop it' is a cancel command (first word match)")
    func stopItIsCancel() {
        #expect(TriggerWordDetector.isCancelCommand("stop it") == true)
    }

    @Test("'CANCEL' is a cancel command (case insensitive)")
    func uppercaseCancel() {
        #expect(TriggerWordDetector.isCancelCommand("CANCEL") == true)
    }

    @Test("'run something' is not a cancel command")
    func runIsNotCancel() {
        #expect(TriggerWordDetector.isCancelCommand("run something") == false)
    }

    @Test("empty string is not a cancel command")
    func emptyIsNotCancel() {
        #expect(TriggerWordDetector.isCancelCommand("") == false)
    }

    @Test("whitespace-only string is not a cancel command")
    func whitespaceIsNotCancel() {
        #expect(TriggerWordDetector.isCancelCommand("   ") == false)
    }

    @Test("'cancelled' is not a cancel command (must be exact first word)")
    func cancelledIsNotCancel() {
        #expect(TriggerWordDetector.isCancelCommand("cancelled") == false)
    }

    @Test("'do not cancel' is not a cancel command (cancel not first word)")
    func doNotCancelIsNotCancel() {
        #expect(TriggerWordDetector.isCancelCommand("do not cancel") == false)
    }

    // MARK: - Trigger Variants List

    @Test("trigger variants list is non-empty and contains 'titus'")
    func triggerVariantsNonEmpty() {
        #expect(!TriggerWordDetector.triggerVariants.isEmpty)
        #expect(TriggerWordDetector.triggerVariants.contains("titus"))
    }

    @Test("all trigger variants are lowercase")
    func triggerVariantsLowercase() {
        for variant in TriggerWordDetector.triggerVariants {
            #expect(variant == variant.lowercased())
        }
    }
}
