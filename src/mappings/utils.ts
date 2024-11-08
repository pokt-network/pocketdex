
// Returns the id of the relay for claim and proof
export function getRelayId({
  applicationId,
  serviceId,
  sessionId,
  supplierId
}: {
  serviceId: string,
  applicationId: string,
  supplierId: string,
  sessionId: string,
}): string {
  return `${supplierId}-${applicationId}-${serviceId}-${sessionId}`;
}
