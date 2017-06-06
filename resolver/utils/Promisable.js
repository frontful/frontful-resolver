class Resolution {
  constructor(results) {
    this.results = results
    this.isResolution = true
  }

  then(resolve) {
    try {
      const result = resolve(this.results)
      this.results = result
      if (this.results && this.results.then) {
        return this.results
      }
      else {
        return this
      }
    }
    catch(error) {
      return Promise.reject(error)
    }
  }

  catch() {
    return this
  }
}

export class Promisable {
  static all(resolvables) {
    let hasPromise = false
    for (let i = 0, l = resolvables.length; i < l; i++) {
      if (resolvables[i] && resolvables[i].then && !resolvables[i].isResolution) {
        hasPromise = true
        break
      }
    }
    if (hasPromise) {
      return Promise.all(resolvables)
    }
    else {
      return new Resolution(resolvables)
    }
  }

  static resolve(resolvable) {
    if (resolvable && resolvable.then && !resolvable.isResolution) {
      return Promise.resolve(resolvable)
    }
    else {
      return new Resolution(resolvable)
    }
  }
}
