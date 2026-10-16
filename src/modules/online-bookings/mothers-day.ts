const MOTHERS_DAY = "2026-10-18";

export function mothersDayNotice(restaurant: { slug?: string; name?: string }) {
  const name = restaurant.name?.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/\s+/g, "-");
  if (restaurant.slug !== "estilo-campo" && name !== "estilo-campo") return null;
  return {
    date: MOTHERS_DAY,
    title: "¿Buscás una reserva especial para el Día de la Madre?",
    introduction: "El servicio es a la carta.",
    benefits: "Por tratarse de un día especial, tendremos regalos y sorteos para todas las madres presentes, únicamente durante el almuerzo.",
    conditions: [
      "Almuerzo únicamente con seña previa. Coordiná tu reserva por WhatsApp.",
      "Primer turno: 12:00 hs. Llegando puntual tenés un 10% de descuento sobre el total de la cuenta con cualquier forma de pago. El beneficio es exclusivo del primer turno. La mesa debe liberarse a las 14:00 hs sin excepción.",
      "Te pedimos llegar puntual para brindarte una mejor experiencia y liberar la mesa a las 14:00 hs para evitar demoras en el siguiente turno. ¡Gracias por tu buena voluntad!",
      "Segundo turno: 14:30 hs.",
      "Seña de $50.000 para reservas de hasta 10 personas y de $100.000 para más de 10 personas, por transferencia o depósito bancario. Alias: BAUMOLCREDICOOP.",
      "Después del pago, envianos el comprobante por WhatsApp. La reserva se confirma cuando se acredita la seña.",
      "Cena: reservas en los horarios habituales a través de esta web, sin regalos ni sorteos."
    ],
    whatsappMessage: "¡Hola! Quiero consultar por una reserva para el almuerzo del Día de la Madre, domingo 18/10/2026."
  };
}

// This restriction applies only to public bookings; staff can still manage lunch.
export function publicBookingTimeAllowed(restaurant: { slug?: string; name?: string }, date: string, time: string) {
  return date !== MOTHERS_DAY || time >= "17:00" || !mothersDayNotice(restaurant);
}
