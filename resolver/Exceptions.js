import ExtendableError from 'es6-error'

class Cancel extends ExtendableError {}

const Exceptions = {
  Cancel,
}

export {
  Exceptions,
}
