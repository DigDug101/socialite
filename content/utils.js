// Nice closure-based partial application method from Greasemonkey.
function GM_hitch(obj, meth) {
  if (!obj[meth]) {
    throw "method '" + meth + "' does not exist on object '" + obj + "'";
  }

  var staticArgs = Array.prototype.splice.call(arguments, 2, arguments.length);

  return function() {
    // make a copy of staticArgs (don't modify it because it gets reused for
    // every invocation).
    var args = staticArgs.concat();

    // add all the new arguments
    // Modification by Chromakode: put non-static arguments first
    // Iterate backwards, adding each argument to the front of the list.
    for (var i = arguments.length-1; i >= 0; i--) {
      args.unshift(arguments[i]);
    }

    // invoke the original function with the correct this obj and the combined
    // list of static and dynamic arguments.
    return obj[meth].apply(obj, args);
  };
}

// Add an event listener that only fires once.
function makeOneShot(instance, type, listener, useCapture) {

  var oneShotListener = function () {
    instance.removeEventListener(type, oneShotListener, useCapture);
    listener.apply(null, arguments);
  }
  
  instance.addEventListener(type, oneShotListener, useCapture);
}
