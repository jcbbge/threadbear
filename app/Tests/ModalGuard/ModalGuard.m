// Under tests a real modal (an alert, a save panel) ends the test run at once,
// with what asked and from where, instead of waiting for a click nobody can
// give. On 7 Nov an xctest sat in OpenGate's alert for 18 minutes on Tinker
// Desk, and every thread's check and landing queued behind it. A test that
// means to reach one stubs the seam in front of it (OpenGate.ask), and one that
// starts a Task has to wait for it: the stub is gone once its test is over.
//
// In Objective-C because Swift has no +load, which runs as the test bundle
// loads, before any test, so no test class has to remember to install it.
// It exits rather than failing the test as a modal can come from a Task left
// over from an earlier test, so there's no telling whose failure it is, and
// exits rather than aborts so a person's Mac gets no "quit unexpectedly".
#import <AppKit/AppKit.h>
#import <objc/runtime.h>
#import "ModalGuard.h"

static NSInteger TBRefuseModal(id self, SEL _cmd) {
    NSString *what = NSStringFromClass([self class]);
    if ([self isKindOfClass:[NSAlert class]]) what = [NSString stringWithFormat:@"NSAlert \"%@\"", [(NSAlert *)self messageText]];
    fprintf(stderr, "\nModalGuard: error: a test reached a real modal (%s), which nobody can answer. Stub what asks, or wait for the Task that reaches it. Stack:\n%s\n",
            what.UTF8String, [NSThread callStackSymbols].description.UTF8String);
    fflush(stderr);
    _exit(1);
}

static NSInteger TBRefuseWindowModal(id self, SEL _cmd, NSWindow *window) {
    return TBRefuseModal(window ?: self, _cmd);
}

@interface TBModalGuard : NSObject
@end

@implementation TBModalGuard
+ (void)load {
    method_setImplementation(class_getInstanceMethod([NSAlert class], @selector(runModal)), (IMP)TBRefuseModal);
    method_setImplementation(class_getInstanceMethod([NSSavePanel class], @selector(runModal)), (IMP)TBRefuseModal);
    method_setImplementation(class_getInstanceMethod([NSApplication class], @selector(runModalForWindow:)), (IMP)TBRefuseWindowModal);
}
@end

BOOL TBModalGuardInstalled(void) {
    return method_getImplementation(class_getInstanceMethod([NSAlert class], @selector(runModal))) == (IMP)TBRefuseModal
        && method_getImplementation(class_getInstanceMethod([NSSavePanel class], @selector(runModal))) == (IMP)TBRefuseModal
        && method_getImplementation(class_getInstanceMethod([NSApplication class], @selector(runModalForWindow:))) == (IMP)TBRefuseWindowModal;
}
