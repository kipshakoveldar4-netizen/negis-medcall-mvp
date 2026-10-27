// Hook-only suites resolve modules eagerly; real chunk delivery is covered in Chromium.
const modules = new WeakMap<object, { value: unknown }>();
export function eagerControlLazy(load: () => Promise<{ default: unknown }>) {
  const token = {}, state = { value: token as unknown };
  modules.set(token, state);
  void load().then(module => { state.value = module.default; });
  return token;
}
export function controlFixtureType(type: unknown) {
  return type && typeof type === "object" ? modules.get(type)?.value ?? type : type;
}
export const controlFixtureSuspense = Symbol("ControlSuspense");
export class ControlFixtureComponent {}
