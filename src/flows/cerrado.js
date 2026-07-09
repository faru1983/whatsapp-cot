// ==============================================================================
// OBJETIVO: Estado terminal CERRADO.
// Cuando el cliente elige la web, cancela, o confirma una cotización, el flujo
// pasa aquí. El bot ya envió customReply y quedó en mute; este estado evita
// que session.currentState apunte a un id inexistente en statesMap.
// ==============================================================================

/**
 * CERRADO: Estado final de la conversación de venta.
 * No hace preguntas ni avanza: si por algún motivo llega un mensaje aquí
 * sin mute (bug), validateAndProcess refuerza el silencio.
 */
export const CERRADO = {
  id: 'CERRADO',
  promptQuestion: () => '',
  shortQuestion: '',
  aiContextPrompt: null,

  /**
   * validateAndProcess: Refuerza mute. No genera respuesta nueva
   * (el cierre ya se envió con customReply en el estado anterior).
   *
   * @returns {{ success: true, mute: true }}
   */
  async validateAndProcess() {
    return { success: true, mute: true };
  }
};
