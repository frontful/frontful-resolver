import React from 'react'
import {Promisable as PromisableClass, deferred, getDisplayName, isBrowser} from 'frontful-utils'
import {observer as mobxObserver} from 'mobx-react'
import {untracked, observable, reaction} from 'mobx'
import {Exceptions} from './Exceptions'

let Promisable = Promise
let observer = (Component) => (Component)

if (isBrowser()) {
  Promisable = PromisableClass
  observer = mobxObserver
}
else {
  Promisable = Promise
  observer = (Component) => (Component)
}

const errorStyle = {
  backgroundColor: 'red',
  color: 'white',
  fontSize: '16px',
  padding: '5px',
  margin: '0',
}

export class Resolver {
  constructor(element, context) {
    this.getRequisites = this.getRequisites.bind(this)
    this.context = context
    this.isResolver = true
    this.Component = element.type
    this.props = element.props
    this.resolvers = this.extractResolvers(this.Component)
    this.resolversTree = this.extractResolversTree(this.resolvers, this.props)
    this.data = observable({
      requisites: {}
    }, {
      requisites: observable.ref
    })
  }

  resolve(untracked, resolvers, ...resolverQueue) {
    if (!this.resolvers) {
      resolverQueue.untracked = untracked
      resolvers.push(resolverQueue)
    }
  }

  getResolveFunction(resolvers) {
    const resolve = this.resolve.bind(this, false, resolvers)
    resolve.untracked = this.resolve.bind(this, true, resolvers)
    resolve.value = (value) => ({__value__: value})
    return resolve
  }

  extractResolvers(Component) {
    const resolvers = []
    Component.__resolver_resolvable__(this.getResolveFunction(resolvers))
    return resolvers
  }

  extractResolversTree(resolvers, props) {
    const extractResolversTreeItem = (resolverQueue, props) => {
      if(resolverQueue.length === 0) {
        return null
      }
      const [resolver, ...restResolverQueue] = resolverQueue
      restResolverQueue.untracked = resolverQueue.untracked
      return {
        resolver: resolverQueue.untracked ? (...args) => untracked(() => resolver(...args)) : resolver,
        props: props,
        next: extractResolversTreeItem(restResolverQueue)
      }
    }

    return resolvers.map((resolverQueue) => {
      return extractResolversTreeItem(resolverQueue, props)
    })
  }

  resolveReturnValues(resolverResult, item, boundProcess, subResolve) {
    if (subResolve) {
      if (Array.isArray(resolverResult)) {
        return resolverResult.reduce((promise, result) => {
          return promise.then((prevRes) => {
            return this.resolveReturnValues({__array__: result}, item, boundProcess, subResolve).then((newRes) => {
              return prevRes.concat(newRes.__array__)
            })
          })
        }, Promise.resolve([]))
      }
    }
    else {
      if (resolverResult && (Array.isArray(resolverResult) || typeof resolverResult !== 'object')) {
        throw new Error('[frontful-resolver] Top level resolvable should only be object')
      }
    }

    resolverResult = resolverResult || {}

    return Promisable.all(
      Object.keys(resolverResult).map((key) => {
        return Promisable.resolve(resolverResult[key]).then((value) => {
          let processedValue = null

          if (React.isValidElement(value)) {
            if (value.type.__resolver_resolved__) {
              processedValue = value
            }
            else if (value.type.__resolver_resolvable__) {
              const resolver = new Resolver(value, this.context)
              item.resolvers.push(resolver)
              processedValue = resolver.execute()
            }
            else {
              processedValue = value
            }
          }
          else if (value && value.hasOwnProperty('__value__')) {
            processedValue = this.resolveReturnValues(value.__value__, item, boundProcess, true)
          }
          else {
            processedValue = value
          }

          return Promisable.resolve(processedValue).then((value) => {
            if (boundProcess.canceled) {
              this.cancel()
            }
            if (value && value.error && value.component) {
              if (item.next) {
                throw value.error
              }
              else {
                value = value.component
              }
            }
            resolverResult[key] = value
            return null
          }).catch((error) => {
            if (boundProcess.canceled) {
              this.cancel()
            }
            else {
              throw error
            }
          })
        })
      })
    ).then(() => {
      if (subResolve) {
        return resolverResult
      }
      else {
        item.resolverResult = resolverResult
        if (item.next) {
          item.next.props = {...item.props, ...item.resolverResult}
          return this.invokeReactivity([item.next])
        }
        else {
          this.setRequisites()
          return this.data.requisites
        }
      }
    })
  }

  cancel() {
    throw new Error('frontful_resolver_cancel_execution')
  }

  itemResolver = (item) => {
    const execution = deferred()
    execution.promise.isProcessing = true

    const resolveProps = () => {
      try {
        return item.resolver({
          ...this.definerObject,
          //...this.Component.__resolver_definer__ ? this.Component.__resolver_definer__(this.context, item.props) : null,
          ...item.props,
          getRequisites: this.getRequisites,
        }) || {}
      }
      catch(error) {
        return Promise.reject(error)
      }
    }

    const reactToProps = (resolverResult) => {
      const processing = item.process && item.process.promise && item.process.promise.isProcessing
      if (processing) {
        item.process.canceled = true
      }

      if (item.resolvers && item.resolvers.length) {
        item.resolvers.forEach((resolver) => {
          resolver.dispose(true)
        })
      }
      this.disposeResolversTree([item.next])

      item.process = {
        promise: null,
        canceled: false,
      }

      const boundProcess = item.process

      item.process.promise = Promisable.resolve(resolverResult).then((resolverResult) => {
        item.resolvers = []
        return this.resolveReturnValues(resolverResult, item, boundProcess)
      }).then(() => {
        if (execution.promise.isProcessing) {
          execution.resolve()
          execution.promise.isProcessing = false
        }
        if (boundProcess.promise) {
          boundProcess.promise.isProcessing = false
        }
        return null
      }).catch((error) => {
        if(error.message === 'frontful_resolver_cancel_execution') {
          if (boundProcess.promise) {
            boundProcess.promise.isProcessing = false
          }
          return
        }
        if (boundProcess.promise) {
          boundProcess.promise.isProcessing = false
        }
        this.data = observable({
          requisites: {}
        }, {
          requisites: observable.ref
        })
        if (execution.promise.isProcessing) {
          execution.reject(error)
          execution.promise.isProcessing = false
        }
        else {
          throw error
        }
      })

      boundProcess.promise.isProcessing = true
    }

    item.disposeReaction = reaction(resolveProps, reactToProps, {
      fireImmediately: true
    })

    return execution.promise
  }

  resolveObject(object) {
    if (object) {
      const keys = Object.keys(object)
      return Promise.all(keys.map((key) => object[key])).then((results) => {
        return keys.reduce((object, key, idx) => {
          object[key] = results[idx]
          return object
        }, {})
      })
    }
    return Promise.resolve(null)
  }

  invokeReactivity(resolversTree) {
    const def = untracked(() => this.Component.__resolver_definer__ ? this.Component.__resolver_definer__(this.context, this.props) : null)
    return this.resolveObject(def).then((definerObject) => {
      this.definerObject = definerObject
      return Promise.all(resolversTree.map(this.itemResolver))
    })
  }

  setRequisites() {
    if (this.isDisposed) {return}

    const extractRequisitesFromResolversTree = (resolversTree) => {
      return resolversTree.reduce((result, item) => {
        if (item) {
          return {
            ...result,
            ...item.resolverResult,
            ...extractRequisitesFromResolversTree([item.next]),
          }
        }
        else {
          return result
        }
      }, {})
    }

    this.data.requisites = extractRequisitesFromResolversTree(this.resolversTree)
  }

  getRequisites() {
    return this.data.requisites
  }

  dispose(full) {
    if (!this.isDisposed) {
      this.disposeResolversTree(this.resolversTree, true)
      if (full) {
        this.isResolver = null
        this.Component = null
        this.props = null
        this.resolvers = null
        this.resolversTree = null
        this.data = observable({
          requisites: {}
        }, {
          requisites: observable.ref
        })
        this.data.requisites = null
        this.isDisposed = true
      }
    }
  }

  disposeResolversTree(resolversTree, full) {
    resolversTree.forEach((item) => {
      if (item) {
        if (item.next) {
          this.disposeResolversTree([item.next], full)
        }

        if (item.disposeReaction) {
          item.disposeReaction()
        }

        if (item.resolvers) {
          item.resolvers.forEach((resolver) => {
            resolver.dispose(full)
          })
        }
      }
    })
  }

  rewind() {
    this.dispose(true)
  }

  execute() {
    return this.invokeReactivity(this.resolversTree).then(() => {
      const Component = this.Component
      const getRequisites = this.getRequisites.bind(this)

      const result = observer(
        class Resolver extends React.Component {
          render() {
            const requisites = getRequisites()
            return (
              requisites && Component && <Component resolved={requisites} {...requisites} {...this.props}/>
            )
          }
        }
      )

      result.__resolver_resolved__ = true
      return result
    }).catch((error) => {
      if (error instanceof Exceptions.Cancel) {
        if (!isBrowser()) {
          throw error
        }
        return () => <React.Fragment />
      }

      if (isBrowser()) {
        console.error(error)
      }
      else {
        const parseError = global.frontful && global.frontful.environment && global.frontful.environment.parseError
        console.log(parseError ? parseError(error).color : error)
      }

      class Error extends React.PureComponent {
        static displayName = `Error(${getDisplayName(this.Component)})`
        render() {
          return <pre style={errorStyle}>{error.toString()}</pre>
        }
      }

      return {
        error: error,
        component: Error,
      }
    })
  }
}
