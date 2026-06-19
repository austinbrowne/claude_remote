import Foundation

/// Status of a Claude Code session
public enum SessionStatus: String, Codable, Sendable {
    case idle
    case waiting
    case processing
    case active
    case unknown

    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        let raw = try container.decode(String.self)
        self = SessionStatus(rawValue: raw) ?? .unknown
    }
}

/// A Claude Code session running in iTerm
public struct Session: Codable, Identifiable, Sendable, Equatable {
    public let id: String
    public let name: String
    public let status: SessionStatus
    public let cwd: String?
    public let branch: String?
    public let lastActive: String?
    public let logFile: String?
    public let tty: String?
    public let pid: Int?
    public let isTerminal: Bool

    public init(
        id: String,
        name: String,
        status: SessionStatus = .unknown,
        cwd: String? = nil,
        branch: String? = nil,
        lastActive: String? = nil,
        logFile: String? = nil,
        tty: String? = nil,
        pid: Int? = nil,
        isTerminal: Bool = false
    ) {
        self.id = id
        self.name = name
        self.status = status
        self.cwd = cwd
        self.branch = branch
        self.lastActive = lastActive
        self.logFile = logFile
        self.tty = tty
        self.pid = pid
        self.isTerminal = isTerminal
    }

    private enum CodingKeys: String, CodingKey {
        case id, name, status, cwd, branch, lastActive, logFile, tty, pid, isTerminal
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        name = try container.decode(String.self, forKey: .name)
        status = try container.decodeIfPresent(SessionStatus.self, forKey: .status) ?? .unknown
        cwd = try container.decodeIfPresent(String.self, forKey: .cwd)
        branch = try container.decodeIfPresent(String.self, forKey: .branch)
        lastActive = try container.decodeIfPresent(String.self, forKey: .lastActive)
        logFile = try container.decodeIfPresent(String.self, forKey: .logFile)
        tty = try container.decodeIfPresent(String.self, forKey: .tty)
        isTerminal = try container.decodeIfPresent(Bool.self, forKey: .isTerminal) ?? false
        if let intPid = try? container.decodeIfPresent(Int.self, forKey: .pid) {
            pid = intPid
        } else if let strPid = try? container.decodeIfPresent(String.self, forKey: .pid) {
            pid = Int(strPid)
        } else {
            pid = nil
        }
    }
}
