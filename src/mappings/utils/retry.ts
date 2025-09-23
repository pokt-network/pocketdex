export async function retryOnFail<T>(fn: () => Promise<T>, maxRetries: number, delay: number, retries = 0): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (retries < maxRetries) {
      await new Promise(resolve => setTimeout(resolve, delay));
      return retryOnFail(fn, maxRetries, delay, retries + 1);
    } else {
      throw new Error(`[retryFunction] max retries reached, last error: ${e instanceof Error ? e.message : e}`);
    }
  }
}
