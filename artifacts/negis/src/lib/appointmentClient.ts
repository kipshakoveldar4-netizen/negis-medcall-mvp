export type AppointmentClientFields = {
  clientId: string;
  client: string;
  phone: string;
  whatsapp: string;
};

export function selectAppointmentClient<T extends AppointmentClientFields>(
  current: T,
  selected: { id: string; name: string; phone: string; whatsapp: string },
): T {
  return {
    ...current,
    clientId: selected.id,
    client: selected.name,
    phone: selected.phone,
    whatsapp: selected.whatsapp || selected.phone,
  };
}

export function editAppointmentClient<T extends AppointmentClientFields>(
  current: T,
  field: "client" | "phone" | "whatsapp",
  value: string,
): T {
  if (current[field] === value) return current;
  // An inherited second contact must not link the replacement person back
  // to the old card when the server resolves the new appointment.
  return {
    ...current,
    ...(current.clientId ? { phone: "", whatsapp: "" } : {}),
    clientId: "",
    [field]: value,
  };
}
