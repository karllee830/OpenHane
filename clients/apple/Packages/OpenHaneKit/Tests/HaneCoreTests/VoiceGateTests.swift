@testable import HaneCore
import Testing

/// 与 Web 版 packages/audio-dsp/src/gate.test.ts 相同的用例。
@Suite struct VoiceGateTests {
    private func run(_ g: inout VoiceGate, _ frames: Int, _ level: Double, vad: Double? = nil) -> Bool {
        var open = false
        for _ in 0 ..< frames { open = g.update(levelDb: level, vad: vad) }
        return open
    }

    @Test func voiceActivationOpensAndHolds300ms() {
        var g = VoiceGate(mode: .voice)
        #expect(run(&g, 100, -70) == false)
        #expect(g.noiseFloorDb < -65)
        #expect(g.update(levelDb: -30) == true)
        #expect(run(&g, 29, -70) == true)
        #expect(run(&g, 1, -70) == false)
    }

    @Test func usesVADWhenAvailable() {
        var g = VoiceGate(mode: .voice)
        _ = run(&g, 100, -60, vad: 0.01)
        #expect(g.update(levelDb: -35, vad: 0.05) == false)
        #expect(g.update(levelDb: -35, vad: 0.9) == true)
    }

    @Test func adaptsToNoisyRoom() {
        var g = VoiceGate(mode: .voice)
        _ = run(&g, 500, -45)
        #expect(g.thresholdDb > -40)
        #expect(g.update(levelDb: -44) == false)
    }

    @Test func pushToTalkWith200msRelease() {
        var g = VoiceGate(mode: .ptt)
        #expect(g.update(levelDb: -20) == false)
        g.pttPressed = true
        #expect(g.update(levelDb: -80) == true)
        g.pttPressed = false
        #expect(run(&g, 19, -20) == true)
        #expect(run(&g, 1, -20) == false)
    }

    @Test func manualThresholdAndOpenMode() {
        var g = VoiceGate(mode: .voice, manualThresholdDb: -40)
        #expect(g.update(levelDb: -45) == false)
        #expect(g.update(levelDb: -35) == true)
        var o = VoiceGate(mode: .open)
        #expect(o.update(levelDb: -100) == true)
    }

    @Test func lsnrMapsToSpeechProbability() {
        #expect(abs(lsnrToVad(0)! - 0.5) < 1e-9)
        #expect(lsnrToVad(-15)! < 0.01)
        #expect(lsnrToVad(10)! > 0.95)
        #expect(lsnrToVad(3)! > lsnrToVad(2)!)
        #expect(lsnrToVad(.nan) == nil)
    }
}
