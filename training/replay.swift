import Foundation

/// 현재 앱처럼 종료 여부를 묻고 분석을 계속하며, 모든 확인 요청을 별도로 기록합니다.
@main enum ReplayTraining {
    static func main() throws {
        let a = CommandLine.arguments
        precondition(a.count == 5)
        let input = try Data(contentsOf: URL(fileURLWithPath: a[1]))
        let pcm = input.withUnsafeBytes { Array($0.bindMemory(to: Float.self)) }
        let root = URL(fileURLWithPath: a[2])
        func url(_ name: String) -> URL { root.appendingPathComponent(name + ".mlmodelc") }
        let model = try ChicModelV3_5(gateURL: url("ChicModelV3_5Gate"), airURL: url("ChicModelV3_5Air"), rollingURL: url("ChicModelV3_5Metallic"), startURL: url("ChicStartSoundV1"))
        let end = try ChicEndDetector(modelURL: URL(fileURLWithPath: a[3]), classifierURL: url("ChicEndV3_5"))
        var rule = ChicEndRule(), display = ChicDisplayFilter()
        var raw = [Int](), shown = [Int](), scores = [[Double]](), requests = [[String:Any]]()
        var startTime: Double?, startReason: String?
        func code(_ state: ChicModelV3_5.State) -> Int {
            switch state { case .air: 0; case .sputter: 1; case .metallic: 2; case .other: 3 }
        }
        for offset in stride(from: 0, to: pcm.count, by: 4800) {
            let chunk = Array(pcm[offset..<min(offset+4800,pcm.count)])
            try end.append(chunk)
            try model.consume(chunk, sampleRate: 48000, onSpectrum: { spectrum in
                guard let s = try end.consume(spectrum: spectrum) else { return }
                scores.append([s.other,s.work,s.end,s.purge])
                if let reason = rule.consume(work:s.work,end:s.end,purge:s.purge) {
                    let time = Double(2048+(scores.count*10-1)*512)/48000
                    let name = switch reason { case .endSound: "endSound"; case .disappearance: "disappearance"; case .cleaning: "cleaning" }
                    requests.append(["time":time,"reason":name,"lookbackCount":reason.lookbackCount])
                }
            }) { frame in
                raw.append(code(frame.state))
                if let reason = frame.startReason {
                    display.activate();rule.activate()
                    startTime=Double(2048+(raw.count-1)*512)/48000;startReason=reason.rawValue
                }
                let current=display.consume(frame.state)
                if raw.count%10==0 { shown.append(model.isStarted ? current.map(code) ?? -1 : -1) }
            }
        }
        precondition(shown.count==scores.count && raw.count/10==scores.count)
        let output:[String:Any] = ["raw":raw,"shown":shown,"scores":scores,"endRequests":requests,
            "startTime":startTime ?? NSNull() as Any,"startReason":startReason ?? NSNull() as Any,
            "endTime":requests.first?["time"] ?? NSNull(),"endReason":requests.first?["reason"] ?? NSNull()]
        try JSONSerialization.data(withJSONObject:output,options:[.sortedKeys]).write(to:URL(fileURLWithPath:a[4]),options:.atomic)
        print("Replayed",raw.count,"frames; end requests",requests.count)
    }
}
