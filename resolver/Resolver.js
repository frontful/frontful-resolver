import ExtendableError from 'es6-error'
import React from 'react'
import {Promisable as PromisableClass} from './utils/Promisable'
import {deferred} from './utils/deferred'
import {getDisplayName} from './utils/getDisplayName'
import {isBrowser} from './utils/isBrowser'
import {observer as mobxObserver} from 'mobx-react'
import {untracked, observable, reaction} from 'mobx'

class CanceledException extends ExtendableError {}

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
      requisites: observable.ref({})
    })
  }

  resolve(once, resolvers, ...resolverQueue) {
    if (!this.resolvers) {
      resolverQueue.once = once
      resolvers.push(resolverQueue)
    }
  }

  getResolveFunction(resolvers) {
    const resolve = this.resolve.bind(this, false, resolvers)
    resolve.once = this.resolve.bind(this, true, resolvers)
    return resolve
  }

  extractResolvers(Component) {
    const resolvers = []
    Component.resolvable(this.getResolveFunction(resolvers))
    return resolvers
  }

  extractResolversTree(resolvers, props) {
    const extractResolversTreeItem = (resolverQueue, props) => {
      if(resolverQueue.length === 0) {
        return null
      }
      const [resolver, ...restResolverQueue] = resolverQueue
      restResolverQueue.once = resolverQueue.once
      return {
        resolver: resolverQueue.once ? (...args) => untracked(() => resolver(...args)) : resolver,
        props: props,
        next: extractResolversTreeItem(restResolverQueue)
      }
    }

    return resolvers.map((resolverQueue) => {
      return extractResolversTreeItem(resolverQueue, props)
    })
  }

  resolveReturnValues(resolverResult, item, boundProcess) {
    if (Array.isArray(resolverResult)) {
      return resolverResult.reduce((promise, result) => {
        return promise.then((prevRes) => {
          return this.resolveReturnValues({__syncValue: result}, item, boundProcess).then((newRes) => {
            return prevRes.concat(newRes.__syncValue)
          })
        })
      }, Promise.resolve([])).then((__array) => {
        item.resolverResult = {__array}
        this.setRequisites()
        return this.data.requisites
      })
    }

    resolverResult = resolverResult || {}
    return Promisable.all(
      Object.keys(resolverResult).map((key) => {
        return Promisable.resolve(resolverResult[key]).then((value) => {
          let processedValue = null

          if (React.isValidElement(value)) {
            if (value.type.resolved) {
              processedValue = value
            }
            else if (value.type.resolvable) {
              const resolver = new Resolver(value, this.context)
              item.resolvers.push(resolver)
              processedValue = resolver.execute()
            }
            else {
              processedValue = value.type
            }
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
      item.resolverResult = resolverResult
      if (item.next) {
        item.next.props = {...item.props, ...item.resolverResult}
        return this.invokeReactivity([item.next])
      }
      else {
        this.setRequisites()
        return this.data.requisites
      }
    })
  }

  cancel() {
    throw new CanceledException()
  }

  invokeReactivity(resolversTree) {
    return Promise.all(
      resolversTree.map((item) => {
        const execution = deferred()
        execution.promise.isProcessing = true

        const resolveProps = () => {
          try {
            return item.resolver({
              ...this.Component.configurator ? this.Component.configurator(this.context) : null,
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
          }).catch(CanceledException, () => {
            if (boundProcess.promise) {
              boundProcess.promise.isProcessing = false
            }
          }).catch((error) => {
            if (boundProcess.promise) {
              boundProcess.promise.isProcessing = false
            }
            this.data = observable({
              requisites: observable.ref({})
            })
            if (execution.promise.isProcessing) {
              execution.reject(error)
              execution.promise.isProcessing = false
            }
            else {
              if (!error.response) {
                throw error
              }
            }
          })

          boundProcess.promise.isProcessing = true
        }

        item.disposeReaction = reaction(resolveProps, reactToProps, true)

        return execution.promise
      })
    )
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
        this.data = observable({requisites: observable.ref({})})
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
    const inlineErrors = true

    return this.invokeReactivity(this.resolversTree).then(() => {
      const Component = this.Component
      const getRequisites = this.getRequisites.bind(this)

      const result = (
        observer(
          class Resolver extends React.PureComponent {
            static displayName = `Resolver(${getDisplayName(Component)})`

            render() {
              const requisites = getRequisites()
              return (
                requisites && Component && <Component requisites={requisites} {...this.props} {...requisites}/>
              )
            }
          }
        )
      )
      result.resolved = true
      return result
    }).catch((error) => {
      class Error extends React.PureComponent {
        static displayName = `Error(${getDisplayName(this.Component)})`

        render() {
          return inlineErrors ? (
            <pre style={{
              fontSize: '10px',
              margin: '5px',
              padding: '5px',
              backgroundColor: 'red',
              color: 'white',
            }}>
              {JSON.stringify(error, null, 2)}
            </pre>
          ) : null
        }
      }
      return {
        error: error,
        component: Error,
      }
    })
  }
}
