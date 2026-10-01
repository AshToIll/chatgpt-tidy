import "../../../platform/protocol.js";

// Navigation state belongs solely to the existing worker-navigation service.
export function createNavigationHandler({ navigation }) {
  const protocol = globalThis.TidyProtocol;
  return Object.freeze({
    types: Object.freeze([protocol.Type.NAVIGATION_CANCELLED, protocol.Type.SEARCH_OPEN_RESULT]),
    handle: ({ envelope, sender, navigationHandle }) => envelope.type === protocol.Type.NAVIGATION_CANCELLED
      ? navigation.cancel(envelope.payload || {}, sender)
      : navigation.openSearch(navigationHandle, envelope.payload || {}, sender),
  });
}
