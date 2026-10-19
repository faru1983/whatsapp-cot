// ==============================================================================
// Script de prueba y verificación integral del Agente IA blindado.
// Simula paso a paso la conversación exacta de las capturas del usuario:
// 1. Cliente responde al anuncio Meta Ads: "07 de diciembre, las Vizcachas" + "80 aprox"
// 2. Cliente responde: "2 o 3" (debe tomar 3 y entregar propuesta con costo x trago)
// 3. Cliente responde: "sí" (debe enviar la carta con imagen)
// 4. Cliente elige cócteles: "10L mojito y 10L aperol spritz" (debe armar carrito)
// 5. Cliente confirma carrito: "está perfecto" (como ya sabe fecha y comuna, MUTE + ALERTA SOS silenciosa)
// ==============================================================================

import assert from 'node:assert';
import { processAiAgentMessage } from '../src/agent-ia/index.js';
import { getSession, resetSession } from '../src/core/db.js';

async function runVerification() {
  const testSessionId = 'test-bulletproof-client@s.whatsapp.net';
  resetSession(testSessionId);

  const adminAlerts = [];
  const options = {
    clientPhoneE164: '+56987654321',
    pushName: 'Camila Test',
    sendAdminAlert: async (alert) => {
      adminAlerts.push(alert);
    }
  };

  console.log('🧪 [TEST 1] Cliente responde con fecha y comuna (Las Vizcachas) en primer mensaje:');
  const reply1 = await processAiAgentMessage(testSessionId, '07 de diciembre, las Vizcachas', options);
  console.log('Bot Turn 1:', reply1);
  assert.ok(reply1, 'Debe haber respuesta en el turno 1');
  assert.match(reply1, /07 de diciembre/i, 'Debe reconocer la fecha');
  assert.match(reply1, /Puente Alto|Vizcachas/i, 'Debe reconocer el sector o comuna');
  assert.match(reply1, /¿Cuántos invitados/i, 'Debe preguntar por los invitados de inmediato');

  console.log('\n🧪 [TEST 2] Cliente responde con invitados "80 aprox":');
  const reply2 = await processAiAgentMessage(testSessionId, '80 aprox', options);
  console.log('Bot Turn 2:', reply2);
  const sessionAfterTurn2 = getSession(testSessionId);
  assert.strictEqual(sessionAfterTurn2.guests, 80, 'Debe registrar 80 invitados');
  assert.match(String(reply2), /tragos por persona/i, 'Debe preguntar tragos por persona sin errores');

  console.log('\n🧪 [TEST 3] Cliente responde rango ambiguo "2 o 3":');
  const reply3 = await processAiAgentMessage(testSessionId, '2 o 3', options);
  console.log('Bot Turn 3:', reply3);
  const sessionAfterTurn3 = getSession(testSessionId);
  assert.strictEqual(sessionAfterTurn3.drinksPerGuest, 3, 'Debe resolver "2 o 3" automáticamente al estándar recomendado (3)');
  assert.ok(sessionAfterTurn3.proposalDelivered, 'Debe marcar proposalDelivered');
  const reply3Text = Array.isArray(reply3) ? reply3.join('\n') : String(reply3);
  assert.match(reply3Text, /Presupuesto Estimado/i, 'Debe contener el presupuesto');
  assert.match(reply3Text, /carta de variedades/i, 'Debe ofrecer la carta');

  console.log('\n🧪 [TEST 4] Cliente responde "sí" para ver la carta:');
  const reply4 = await processAiAgentMessage(testSessionId, 'sí porfa', options);
  console.log('Bot Turn 4:', reply4);
  assert.ok(Array.isArray(reply4), 'Debe enviar múltiples burbujas');
  const hasImg = reply4.some(b => typeof b === 'object' && b.type === 'image');
  assert.ok(hasImg, 'Debe incluir la imagen de la carta');
  const sessionAfterTurn4 = getSession(testSessionId);
  assert.ok(sessionAfterTurn4.catalogSent, 'Debe marcar catálogo enviado');

  console.log('\n🧪 [TEST 5] Cliente elige cócteles "10L mojito y 10L aperol":');
  const reply5 = await processAiAgentMessage(testSessionId, '10L mojito tradicional y 10L aperol spritz', options);
  console.log('Bot Turn 5:', reply5);
  const sessionAfterTurn5 = getSession(testSessionId);
  assert.ok(sessionAfterTurn5.cartSummary, 'Debe haber resumen de carrito');
  assert.strictEqual(sessionAfterTurn5.cartItems?.length, 2, 'Debe registrar los 2 cócteles');

  console.log('\n🧪 [TEST 6] Cliente confirma carrito "perfecto así":');
  const reply6 = await processAiAgentMessage(testSessionId, 'perfecto así', options);
  console.log('Bot Turn 6:', reply6);
  assert.strictEqual(reply6, null, 'El bot debe quedar en SILENCIO ABSOLUTO (null) hacia el cliente porque la fecha ya se conocía');
  const sessionAfterTurn6 = getSession(testSessionId);
  assert.strictEqual(sessionAfterTurn6.isMuted, true, 'El bot debe quedar en MUTE');
  assert.strictEqual(adminAlerts.length, 1, 'Debe haber disparado 1 alerta SOS al administrador');
  console.log('Alerta SOS Admin recibida:\n', adminAlerts[0]);
  assert.match(adminAlerts[0].body, /07 de diciembre/i, 'La alerta debe contener la fecha');
  assert.match(adminAlerts[0].body, /Puente Alto|Vizcachas/i, 'La alerta debe contener la comuna');
  assert.match(adminAlerts[0].body, /80 invitados/i, 'La alerta debe contener los 80 invitados');
  assert.match(adminAlerts[0].body, /Mojito Tradicional/i, 'La alerta debe contener el mojito');
  assert.match(adminAlerts[0].body, /Aperol Spritz/i, 'La alerta debe contener el aperol');

  console.log('\n✅ ¡TODAS LAS PRUEBAS DEL AGENTE IA BLINDADO PASARON CON ÉXITO!');
}

runVerification().catch(err => {
  console.error('❌ Error en verificación:', err);
  process.exit(1);
});
