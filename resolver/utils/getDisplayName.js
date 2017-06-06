export function getDisplayName(Component) {
  return (Component && (Component.displayName || Component.name)) ||  'Component'
}
