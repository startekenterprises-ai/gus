import CoreGraphics
import Foundation

/// Synthetic input for GusMacHost: CGEvent mouse, unicode typing,
/// key combos, and scroll. These post at the HID event tap, so they
/// land wherever the operator's focus actually is — which is exactly
/// why the control plane parks every input action as a one-time
/// approval bound to the exact action before it gets here.

private let eventSource = CGEventSource(stateID: .hidSystemState)

func clickAtPoint(x: Double, y: Double) throws {
    let point = CGPoint(x: x, y: y)
    guard
        let move = CGEvent(mouseEventSource: eventSource, mouseType: .mouseMoved, mouseCursorPosition: point, mouseButton: .left),
        let down = CGEvent(mouseEventSource: eventSource, mouseType: .leftMouseDown, mouseCursorPosition: point, mouseButton: .left),
        let up = CGEvent(mouseEventSource: eventSource, mouseType: .leftMouseUp, mouseCursorPosition: point, mouseButton: .left)
    else {
        throw HostError.message("could not create mouse events")
    }
    move.post(tap: .cghidEventTap)
    down.post(tap: .cghidEventTap)
    up.post(tap: .cghidEventTap)
}

/// Type text as unicode keyboard events, in small chunks — the way
/// synthetic typing survives apps that ignore pasted text.
func typeUnicode(_ text: String) throws {
    for character in text {
        let units = Array(String(character).utf16)
        guard
            let down = CGEvent(keyboardEventSource: eventSource, virtualKey: 0, keyDown: true),
            let up = CGEvent(keyboardEventSource: eventSource, virtualKey: 0, keyDown: false)
        else {
            throw HostError.message("could not create keyboard events")
        }
        down.keyboardSetUnicodeString(stringLength: units.count, unicodeString: units)
        up.keyboardSetUnicodeString(stringLength: units.count, unicodeString: units)
        down.post(tap: .cghidEventTap)
        up.post(tap: .cghidEventTap)
        usleep(2_000)
    }
}

private let keyCodes: [String: CGKeyCode] = [
    "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9,
    "b": 11, "q": 12, "w": 13, "e": 14, "r": 15, "y": 16, "t": 17, "1": 18, "2": 19,
    "3": 20, "4": 21, "6": 22, "5": 23, "=": 24, "9": 25, "7": 26, "-": 27, "8": 28,
    "0": 29, "]": 30, "o": 31, "u": 32, "[": 33, "i": 34, "p": 35, "return": 36,
    "enter": 36, "l": 37, "j": 38, "'": 39, "k": 40, ";": 41, "\\": 42, ",": 43,
    "/": 44, "n": 45, "m": 46, ".": 47, "tab": 48, "space": 49, "`": 50,
    "delete": 51, "backspace": 51, "escape": 53, "esc": 53, "f17": 64, "f18": 79,
    "f19": 80, "f20": 90, "f5": 96, "f6": 97, "f7": 98, "f3": 99, "f8": 100,
    "f9": 101, "f11": 103, "f13": 105, "f16": 106, "f10": 109, "f12": 111,
    "f15": 113, "help": 114, "home": 115, "pageup": 116, "forwarddelete": 117,
    "f4": 118, "end": 119, "f2": 120, "pagedown": 121, "f1": 122, "left": 123,
    "right": 124, "down": 125, "up": 126,
]

/// Post a key combo like "cmd+shift+g" or "return": the last token
/// is the key, the rest are modifiers (cmd/command, shift,
/// opt/alt/option, ctrl/control, fn).
func postKeyCombo(_ combo: String) throws {
    let parts = combo.lowercased().split(separator: "+").map { $0.trimmingCharacters(in: .whitespaces) }
    guard let keyName = parts.last, let code = keyCodes[keyName] else {
        throw HostError.message("unknown key in combo \"\(combo)\" — the last token must be a key name (a letter, return, tab, space, escape, an arrow, f1–f19…)")
    }
    var flags = CGEventFlags()
    for modifier in parts.dropLast() {
        switch modifier {
        case "cmd", "command", "meta": flags.insert(.maskCommand)
        case "shift": flags.insert(.maskShift)
        case "opt", "alt", "option": flags.insert(.maskAlternate)
        case "ctrl", "control": flags.insert(.maskControl)
        case "fn": flags.insert(.maskSecondaryFn)
        default:
            throw HostError.message("unknown modifier \"\(modifier)\" in combo \"\(combo)\"")
        }
    }
    guard
        let down = CGEvent(keyboardEventSource: eventSource, virtualKey: code, keyDown: true),
        let up = CGEvent(keyboardEventSource: eventSource, virtualKey: code, keyDown: false)
    else {
        throw HostError.message("could not create keyboard events")
    }
    down.flags = flags
    up.flags = flags
    down.post(tap: .cghidEventTap)
    up.post(tap: .cghidEventTap)
}

/// Scroll in line units. Sign convention follows the platform:
/// positive wheel data reads as up/left, so "down" sends negative
/// wheel-1 data and "right" negative wheel-2 data.
func scroll(direction: String, amount: Int) throws {
    var wheel1: Int32 = 0
    var wheel2: Int32 = 0
    switch direction {
    case "up": wheel1 = Int32(amount)
    case "down": wheel1 = -Int32(amount)
    case "left": wheel2 = Int32(amount)
    case "right": wheel2 = -Int32(amount)
    default:
        throw HostError.message("unknown scroll direction \"\(direction)\" — expected up, down, left, or right")
    }
    guard let event = CGEvent(
        scrollWheelEvent2Source: eventSource,
        units: .line,
        wheelCount: 2,
        wheel1: wheel1,
        wheel2: wheel2,
        wheel3: 0
    ) else {
        throw HostError.message("could not create a scroll event")
    }
    event.post(tap: .cghidEventTap)
}
