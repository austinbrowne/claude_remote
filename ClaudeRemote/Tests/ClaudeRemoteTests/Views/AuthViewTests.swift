import Testing
import Foundation
@testable import ClaudeRemote

@Suite("AuthHelpers")
struct AuthHelpersTests {

    // MARK: - isInsecureRemote

    @Test("http to remote host is insecure")
    func httpRemoteIsInsecure() {
        #expect(AuthHelpers.isInsecureRemote("http://192.168.1.100:3456") == true)
    }

    @Test("http to localhost is not insecure")
    func httpLocalhostIsSecure() {
        #expect(AuthHelpers.isInsecureRemote("http://localhost:3456") == false)
    }

    @Test("http to 127.0.0.1 is not insecure")
    func httpLoopbackIsSecure() {
        #expect(AuthHelpers.isInsecureRemote("http://127.0.0.1:3456") == false)
    }

    @Test("https to remote host is not insecure")
    func httpsRemoteIsSecure() {
        #expect(AuthHelpers.isInsecureRemote("https://myserver.com:3456") == false)
    }

    @Test("invalid URL is not insecure")
    func invalidURLIsNotInsecure() {
        #expect(AuthHelpers.isInsecureRemote("") == false)
        #expect(AuthHelpers.isInsecureRemote("not a url") == false)
    }

    @Test("http to domain name is insecure")
    func httpDomainIsInsecure() {
        #expect(AuthHelpers.isInsecureRemote("http://myserver.example.com") == true)
    }
}
