export default async function globalTeardown(): Promise<void> {
  await globalThis.__FILEGRID_TEST_PG__?.stop();
}
