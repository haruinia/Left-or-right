import CoreGraphics
import Foundation

// Use a listen-only event tap so injected and physical modifier changes are both
// delivered immediately. The 25 ms flags poll below remains as a fallback for a
// host that cannot create a tap; it also repairs state after a missed event.
let sourceState = CGEventSourceStateID.combinedSessionState
var previous = false

func emit(_ current: Bool) {
    if current != previous {
        print(current ? "1" : "0")
        fflush(stdout)
        previous = current
    }
}

let mask = CGEventMask(1 << CGEventType.flagsChanged.rawValue)
let tap = CGEvent.tapCreate(
    tap: .cgSessionEventTap,
    place: .headInsertEventTap,
    options: .listenOnly,
    eventsOfInterest: mask,
    callback: { _, type, event, _ in
        if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
            return Unmanaged.passUnretained(event)
        }
        emit(event.flags.contains(.maskCommand))
        return Unmanaged.passUnretained(event)
    },
    userInfo: nil
)

if let tap {
    let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0)
    CFRunLoopAddSource(CFRunLoopGetCurrent(), source, .commonModes)
    CGEvent.tapEnable(tap: tap, enable: true)
}

// Keep the poll on the main run loop. This gives a reliable fallback without
// blocking the event tap and avoids one process-wide sleep loop per launch.
let timer = Timer.scheduledTimer(withTimeInterval: 0.025, repeats: true) { _ in
    emit(CGEventSource.flagsState(sourceState).contains(.maskCommand))
}
RunLoop.main.add(timer, forMode: .common)
RunLoop.main.run()
