// Metro resolves image imports to an asset module at bundle time; TypeScript
// needs telling. Expo's own declarations cover CSS only, not images.
declare module '*.jpg' {
  const source: number;
  export default source;
}
