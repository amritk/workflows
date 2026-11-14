// The program the workflows repository releases to test itself: it prints its
// name and version, which is all the release's version check asks of a binary.
export const main = (): number => {
  console.log("hello 0.1.0")
  return 0
}
