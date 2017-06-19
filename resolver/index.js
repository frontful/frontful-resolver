import {Resolver} from './Resolver'
import {Exceptions} from './Exceptions'

function resolver(resolvable) {
  return resolver.bind(resolvable)
}

resolver.define = function(definer) {
  return function(Component) {
    Component.__resolver_definer__ = definer
    return Component
  }
}

resolver.bind = function(resolvable) {
  return function(Component) {
    Component.__resolver_resolvable__ = resolvable
    return Component
  }
}

export {
  Resolver,
  resolver,
  Exceptions,
}
