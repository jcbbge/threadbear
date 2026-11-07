import XCTest
@testable import ThreadbearCore

final class CodeWebAddressTests: XCTestCase {
    func testWebAddressesInCode() {
        XCTAssertEqual(CodeWebAddress.url("github.com/waynesutton/threadbear")?.absoluteString, "https://github.com/waynesutton/threadbear")
        XCTAssertEqual(CodeWebAddress.url("https://docs.convex.dev/home")?.absoluteString, "https://docs.convex.dev/home")
        XCTAssertEqual(CodeWebAddress.url("threadbear.mikecann.app")?.absoluteString, "https://threadbear.mikecann.app")
        XCTAssertEqual(CodeWebAddress.url("http://localhost:5173")?.absoluteString, "http://localhost:5173")
        XCTAssertNotNil(CodeWebAddress.url("www.example.co.uk/path"))
    }

    func testFilesAndCodeStayAsTheyAre() {
        for text in ["deploy.sh", "readme.md", "package.json", "fd68ea4", "npm run build", "foo.bar", "x.ts", "localhost:5173", "obj.method()"] {
            XCTAssertNil(CodeWebAddress.url(text), text)
        }
    }
}
