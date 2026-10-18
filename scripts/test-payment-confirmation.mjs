// ==============================================================================
// TEST: Detección y respuesta de confirmación de pago de barril desechable
// ==============================================================================

import { isPaymentConfirmationText } from '../src/agent-ia/context-analyzer.js';
import { processAiAgentMessage } from '../src/agent-ia/index.js';
import { resetSession, getSession } from '../src/core/db.js';

console.log('🧪 Probando isPaymentConfirmationText...');

const positiveCases = [
  'Hola, aquí te dejo el comprobante de pago del barril',
  'Listo ya transferí por el barril de mojito',
  'Te adjunto el comprobante de transferencia',
  'comprobante',
  'Ya pagué el barril desechable de 5L',
  'Acabo de pagar mi pedido en la web',
  'Pagué el barril por la página',
  'Pago realizado',
  'Listo el pago',
  'Ya deposité a su cuenta corriente',
  '[Comprobante de pago / transferencia adjunto]',
  'Hola buenas tardes, pagué mi barril',
  'Te transferí los 32 mil del pisco sour'
];

const negativeCases = [
  '¿Cómo puedo pagar?',
  '¿Aceptan transferencia bancaria?',
  '¿Se puede pagar con tarjeta de crédito?',
  '¿Cuáles son los medios de pago?',
  '¿Me mandas los datos de transferencia para pagar?',
  'Hola, somos 20 personas para un cumpleaños',
  'Quiero 2 tragos por persona',
  '¿Cuánto cuesta el servicio para eventos?'
];

let allPassed = true;

for (const phrase of positiveCases) {
  const result = isPaymentConfirmationText(phrase);
  if (!result) {
    console.error(`❌ Falló positivo (debía ser true): "${phrase}"`);
    allPassed = false;
  } else {
    console.log(`✅ Positivo OK: "${phrase}"`);
  }
}

for (const phrase of negativeCases) {
  const result = isPaymentConfirmationText(phrase);
  if (result) {
    console.error(`❌ Falló negativo (debía ser false): "${phrase}"`);
    allPassed = false;
  } else {
    console.log(`✅ Negativo OK: "${phrase}"`);
  }
}

if (!allPassed) {
  console.error('\n❌ Algunas pruebas de isPaymentConfirmationText fallaron.');
  process.exit(1);
}

console.log('\n🧪 Probando processAiAgentMessage con comprobante...');

const TEST_SESSION = 'test-payment-confirmation@s.whatsapp.net';
resetSession(TEST_SESSION);

let adminAlertReceived = null;
const mockAlertAdmin = async (alert) => {
  adminAlertReceived = alert;
};

const reply = await processAiAgentMessage(TEST_SESSION, 'Hola, adjunto comprobante de pago de mi barril de 5L', {
  sendAdminAlert: mockAlertAdmin,
  clientPhoneE164: '+56912345678',
  pushName: 'Juan Pérez'
});

console.log('Respuesta del agente:', reply);

if (reply !== '¡Muchas gracias! Revisamos y te confirmamos enseguida 🍹') {
  console.error(`❌ Respuesta inesperada: "${reply}"`);
  process.exit(1);
}

const sessionAfter = getSession(TEST_SESSION);
if (!sessionAfter.isMuted) {
  console.error('❌ La sesión debió quedar en isMuted = true');
  process.exit(1);
}

if (!adminAlertReceived) {
  console.error('❌ No se recibió alerta de admin');
  process.exit(1);
}

console.log('Alerta admin recibida:', adminAlertReceived.title);

// Probar mensaje subsecuente del cliente mientras está en mute
const followUpReply = await processAiAgentMessage(TEST_SESSION, '¿Cuándo me llega el barril?', {
  sendAdminAlert: mockAlertAdmin
});

if (followUpReply !== null) {
  console.error(`❌ Mensaje subsecuente debió ser null (en silencio), pero fue: "${followUpReply}"`);
  process.exit(1);
}

console.log('✅ Mensaje subsecuente en silencio OK (MUTE activo)');
console.log('\n🎉 TODAS LAS PRUEBAS DE PAGO PASARON EXITOSAMENTE!');
process.exit(0);
