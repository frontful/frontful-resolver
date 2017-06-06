import {Resolver} from './Resolver'

function resolver(resolvable) {
  return resolver.bind(resolvable)
}

resolver.config = function(configurator) {
  return function(Component) {
    Component.configurator = configurator
    return Component
  }
}

resolver.bind = function(resolvable) {
  return function(Component) {
    Component.resolvable = resolvable
    return Component
  }
}

export {
  Resolver,
  resolver,
}
