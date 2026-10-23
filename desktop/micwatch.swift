// Prints, as one JSON line whenever it changes, which apps are using a microphone right now, from Core Audio's
// list of audio processes (macOS 14 and later). The desktop app uses it to notice a meeting starting and ending.
import CoreAudio
import Foundation

func address(_ selector: AudioObjectPropertySelector) -> AudioObjectPropertyAddress {
  AudioObjectPropertyAddress(mSelector: selector, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
}

func processes() -> [AudioObjectID] {
  var addr = address(kAudioHardwarePropertyProcessObjectList)
  var size: UInt32 = 0
  guard AudioObjectGetPropertyDataSize(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size) == noErr else { return [] }
  var ids = [AudioObjectID](repeating: 0, count: Int(size) / MemoryLayout<AudioObjectID>.size)
  guard AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size, &ids) == noErr else { return [] }
  return ids
}

func number<T: FixedWidthInteger>(_ id: AudioObjectID, _ selector: AudioObjectPropertySelector, _ type: T.Type) -> T? {
  var addr = address(selector)
  var value: T = 0
  var size = UInt32(MemoryLayout<T>.size)
  return AudioObjectGetPropertyData(id, &addr, 0, nil, &size, &value) == noErr ? value : nil
}

func bundle(_ id: AudioObjectID) -> String {
  var addr = address(kAudioProcessPropertyBundleID)
  var value: Unmanaged<CFString>?
  var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
  guard AudioObjectGetPropertyData(id, &addr, 0, nil, &size, &value) == noErr, let s = value?.takeRetainedValue() else { return "" }
  return s as String
}

var last = ""
while true {
  let using = processes()
    .filter { (number($0, kAudioProcessPropertyIsRunningInput, UInt32.self) ?? 0) != 0 }
    .map { ["pid": Int(number($0, kAudioProcessPropertyPID, Int32.self) ?? 0), "bundle": bundle($0)] as [String: Any] }
  if let data = try? JSONSerialization.data(withJSONObject: using, options: [.sortedKeys]), let line = String(data: data, encoding: .utf8), line != last {
    print(line)
    fflush(stdout)
    last = line
  }
  Thread.sleep(forTimeInterval: 2)
}
