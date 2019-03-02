module.exports = function padLeft(str, padChar, numberOfChars) {
  var pad = "";
  for (var i = 0; i < numberOfChars; i++) {
    pad += padChar;
  }
  var result = pad + str;
  return result.substring(result.length - numberOfChars, result.length); 
};