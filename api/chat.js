// ============================================================
// GanjAI AI Assistant — Vercel Serverless Proxy (KB-Powered)
// File: api/chat.js
// 
// This replaces your current api/chat.js in the cannamd-api
// Vercel project.
//
// REQUIRED ENVIRONMENT VARIABLES (set in Vercel Dashboard):
//   ANTHROPIC_API_KEY     - Your Claude API key (already set)
//   SUPABASE_URL          - Your Supabase project URL
//   SUPABASE_ANON_KEY     - Your Supabase anon/public key
// ============================================================

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { system, messages, market } = req.body;

    // Get the latest user message for keyword detection
    const latestMessage = messages[messages.length - 1]?.content?.toLowerCase() || '';

    // Detect what KB data to load based on the message
    const kbNeeds = detectKBNeeds(latestMessage);

    // Fetch KB data from Supabase
    const kbData = await fetchKBData(kbNeeds, market);

    // Build the KB section for the system prompt
    const kbSection = formatKBForPrompt(kbData);

    // Replace the placeholder in the system prompt with real KB data
    const enrichedSystem = system.replace(
      '===CLINICAL_KB_DATA_PLACEHOLDER===',
      kbSection
    );

    // Forward to Claude
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1024,
        system: enrichedSystem,
        messages: messages
      })
    });

    const data = await response.json();
    return res.status(200).json(data);

  } catch (error) {
    console.error('API Error:', error);
    return res.status(500).json({ error: 'Failed to process request' });
  }
}

// ============================================================
// KEYWORD DETECTION
// Determines which KB tables to fetch based on the user's message
// ============================================================
function detectKBNeeds(message) {
  const needs = {
    interactions: false,
    adverse: false,
    contra: false,
    research: false,
    pk: false,
    compound: null   // specific compound to deep-dive
  };

  // Drug interaction keywords
  const drugKeywords = [
    'warfarin', 'clobazam', 'valproate', 'opioid', 'benzo', 'ssri', 'metformin',
    'interaction', 'drug', 'medication', 'medicine', 'combine', 'together with',
    'co-administ', 'cyp', 'enzyme', 'metaboli', 'blood thinner', 'antidepressant',
    'statin', 'omeprazole', 'diazepam', 'morphine', 'fentanyl', 'codeine',
    'anticoagul', 'phenytoin', 'carbamazepine', 'clopidogrel', 'nsaid',
    'ibuprofen', 'paracetamol', 'acetaminophen'
  ];
  if (drugKeywords.some(k => message.includes(k))) needs.interactions = true;

  // Adverse effect keywords
  const aeKeywords = [
    'side effect', 'adverse', 'safety', 'tolerat', 'risk', 'danger', 'harm',
    'nausea', 'dizz', 'drowsy', 'sedation', 'anxiety', 'paranoi', 'psycho',
    'tachycard', 'heart rate', 'appetite', 'dry mouth', 'depend', 'addict',
    'withdraw', 'liver', 'hepato', 'rash'
  ];
  if (aeKeywords.some(k => message.includes(k))) needs.adverse = true;

  // Contraindication keywords
  const ciKeywords = [
    'contraindic', 'pregnant', 'pregnanc', 'elderly', 'hepatic', 'liver',
    'renal', 'kidney', 'heart', 'cardiac', 'psychos', 'schizo', 'driving',
    'operat', 'machinery', 'breastfeed', 'lactation', 'pediatric', 'child',
    'adolescent', 'teen', 'can i prescribe', 'safe for', 'safe to'
  ];
  if (ciKeywords.some(k => message.includes(k))) needs.contra = true;

  // Research keywords
  const rsKeywords = [
    'study', 'trial', 'evidence', 'research', 'rct', 'publish', 'paper',
    'proof', 'clinical data', 'literature', 'proven', 'fda', 'approved',
    'epidiolex', 'sativex'
  ];
  if (rsKeywords.some(k => message.includes(k))) needs.research = true;

  // PK keywords
  const pkKeywords = [
    'dose', 'dosing', 'how much', 'route', 'oral', 'inhale', 'smoke', 'vape',
    'bioavail', 'half-life', 'halflife', 'metaboli', 'absorb', 'sublingual',
    'oil', 'flower', 'titrat', 'start low', '11-oh', 'first-pass'
  ];
  if (pkKeywords.some(k => message.includes(k))) needs.pk = true;

  // Specific compound detection
  const compoundMap = {
    'thc': 'THC', 'cbd': 'CBD', 'cbg': 'CBG', 'cbn': 'CBN', 'cbc': 'CBC',
    'thcv': 'THCV', 'cbdv': 'CBDV',
    'myrcene': 'Myrcene', 'caryophyllene': 'β-Caryophyllene',
    'limonene': 'Limonene', 'linalool': 'Linalool', 'pinene': 'α-Pinene',
    'humulene': 'α-Humulene', 'terpinolene': 'Terpinolene',
    'nerolidol': 'Nerolidol', 'bisabolol': 'α-Bisabolol',
    'eucalyptol': '1,8-Cineole', 'cineole': '1,8-Cineole',
    'ocimene': 'Ocimene', 'borneol': 'Borneol'
  };

  for (const [keyword, compoundId] of Object.entries(compoundMap)) {
    // Use word boundary-like check to avoid false matches
    if (message.includes(keyword)) {
      needs.compound = compoundId;
      break; // Take the first match
    }
  }

  return needs;
}

// ============================================================
// SUPABASE FETCH
// Fetches KB data based on detected needs
// ============================================================
async function fetchKBData(needs, market) {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseKey) {
    console.error('Supabase credentials not configured');
    return { compounds: [], clinicalNotes: [], regulatory: [] };
  }

  const headers = {
    'apikey': supabaseKey,
    'Authorization': `Bearer ${supabaseKey}`,
    'Content-Type': 'application/json'
  };

  // Helper to fetch from Supabase REST API
  async function supabaseFetch(table, queryParams = '') {
    try {
      const url = `${supabaseUrl}/rest/v1/${table}?${queryParams}`;
      const resp = await fetch(url, { headers });
      if (!resp.ok) {
        console.error(`Supabase error for ${table}:`, resp.status);
        return [];
      }
      return await resp.json();
    } catch (err) {
      console.error(`Supabase fetch error for ${table}:`, err);
      return [];
    }
  }

  // ALWAYS LOAD: compact compound summaries
  const compounds = await supabaseFetch(
    'kb_compounds',
    'select=compound_id,compound_type,full_name,psychoactive,summary,key_clinical_note&order=compound_type,compound_id'
  );

  // ALWAYS LOAD: clinical notes
  const clinicalNotes = await supabaseFetch(
    'kb_clinical_notes',
    'select=title,content,internal_only'
  );

  // ALWAYS LOAD: regulatory data for physician's market
  let regulatory = [];
  if (market) {
    regulatory = await supabaseFetch(
      'kb_regulatory',
      `select=category,detail,status_requirement,ai_guidance&market=eq.${market}`
    );
    // Also load comparison rows
    const comparisons = await supabaseFetch(
      'kb_regulatory',
      'select=category,detail,status_requirement,ai_guidance&market=eq.COMPARISON'
    );
    regulatory = [...regulatory, ...comparisons];
  }

  // ON-DEMAND: based on keyword detection
  let interactions = [];
  let adverse = [];
  let contra = [];
  let research = [];
  let pk = [];

  if (needs.interactions) {
    interactions = await supabaseFetch(
      'kb_drug_interactions',
      'select=compound_id,interaction_target,interaction_type,drugs_at_risk,clinical_risk,clinical_guidance'
    );
  }

  if (needs.adverse) {
    adverse = await supabaseFetch(
      'kb_adverse_effects',
      'select=compound_id,effect,frequency,severity,dose_dependent,notes'
    );
  }

  if (needs.contra) {
    contra = await supabaseFetch(
      'kb_contraindications',
      'select=compound_id,contraindication_type,condition_or_population,guidance,rationale'
    );
  }

  if (needs.research) {
    research = await supabaseFetch(
      'kb_research',
      'select=compound_id,study_name,design,status,key_finding,study_year,limitations'
    );
  }

  if (needs.pk) {
    pk = await supabaseFetch(
      'kb_pharmacokinetics',
      'select=compound_id,route,bioavailability,tmax,half_life,metabolism_enzymes,distribution_notes'
    );
  }

  // If a specific compound was mentioned, load everything for it
  if (needs.compound) {
    const cid = needs.compound;
    const filter = `compound_id=eq.${encodeURIComponent(cid)}`;

    if (!needs.interactions) {
      const ci = await supabaseFetch('kb_drug_interactions', `select=compound_id,interaction_target,drugs_at_risk,clinical_risk,clinical_guidance&${filter}`);
      interactions = [...interactions, ...ci];
    }
    if (!needs.adverse) {
      const ae = await supabaseFetch('kb_adverse_effects', `select=compound_id,effect,frequency,severity,notes&${filter}`);
      adverse = [...adverse, ...ae];
    }
    if (!needs.pk) {
      const pkc = await supabaseFetch('kb_pharmacokinetics', `select=compound_id,route,bioavailability,half_life,distribution_notes&${filter}`);
      pk = [...pk, ...pkc];
    }

    // Always load therapeutic effects for a named compound
    const te = await supabaseFetch(
      'kb_therapeutic_effects',
      `select=compound_id,indication,effect_summary,evidence_level,confidence,mechanism&${filter}`
    );
    // Store in a special field
    interactions._therapeuticEffects = te;
  }

  return {
    compounds,
    clinicalNotes,
    regulatory,
    interactions,
    adverse,
    contra,
    research,
    pk
  };
}

// ============================================================
// FORMAT KB DATA FOR PROMPT
// Converts fetched data into a readable text block for Claude
// ============================================================
function formatKBForPrompt(kbData) {
  let sections = [];

  // COMPOUNDS (always present)
  if (kbData.compounds?.length) {
    const cannabinoids = kbData.compounds.filter(c => c.compound_type === 'cannabinoid' && !['CBD+THC', 'ECS', 'TERPENES'].includes(c.compound_id));
    const terpenes = kbData.compounds.filter(c => c.compound_type === 'terpene' && c.compound_id !== 'TERPENES');

    let compSection = 'CLINICAL KB — COMPOUND REFERENCE:\n\n';
    compSection += 'CANNABINOIDS:\n';
    for (const c of cannabinoids) {
      compSection += `• ${c.compound_id} (${c.full_name}): ${c.summary?.substring(0, 300) || ''}\n`;
    }
    compSection += '\nTERPENES:\n';
    for (const c of terpenes) {
      compSection += `• ${c.compound_id} (${c.full_name}): ${c.summary?.substring(0, 200) || ''}\n`;
    }
    sections.push(compSection);
  }

  // CLINICAL NOTES (always present)
  if (kbData.clinicalNotes?.length) {
    let notesSection = 'CLINICAL KB — KEY MECHANISM NOTES:\n\n';
    for (const note of kbData.clinicalNotes) {
      if (note.internal_only) {
        notesSection += `[INTERNAL — calibrate your responses but do not quote directly to physicians]\n`;
      }
      notesSection += `${note.title}:\n${note.content?.substring(0, 800) || ''}\n\n`;
    }
    sections.push(notesSection);
  }

  // REGULATORY (if market specified)
  if (kbData.regulatory?.length) {
    let regSection = 'CLINICAL KB — REGULATORY CONTEXT:\n\n';
    for (const r of kbData.regulatory) {
      regSection += `${r.category}: ${r.ai_guidance || r.detail?.substring(0, 200) || ''}\n`;
    }
    sections.push(regSection);
  }

  // DRUG INTERACTIONS (on-demand)
  if (kbData.interactions?.length) {
    let diSection = 'CLINICAL KB — DRUG INTERACTIONS:\n\n';
    for (const di of kbData.interactions) {
      diSection += `• ${di.compound_id} → ${di.interaction_target}: ${di.clinical_guidance || ''} Drugs at risk: ${di.drugs_at_risk || 'N/A'}\n`;
    }
    sections.push(diSection);
  }

  // THERAPEUTIC EFFECTS (on-demand, for specific compound)
  if (kbData.interactions?._therapeuticEffects?.length) {
    let teSection = 'CLINICAL KB — THERAPEUTIC EFFECTS:\n\n';
    for (const te of kbData.interactions._therapeuticEffects) {
      teSection += `• ${te.compound_id} for ${te.indication} [${te.evidence_level}] (confidence: ${te.confidence}): ${te.effect_summary?.substring(0, 300) || ''}\n`;
    }
    sections.push(teSection);
  }

  // ADVERSE EFFECTS (on-demand)
  if (kbData.adverse?.length) {
    let aeSection = 'CLINICAL KB — ADVERSE EFFECTS:\n\n';
    for (const ae of kbData.adverse) {
      aeSection += `• ${ae.compound_id} — ${ae.effect}: Frequency: ${ae.frequency || 'Unknown'}, Severity: ${ae.severity || 'Unknown'}. ${ae.notes || ''}\n`;
    }
    sections.push(aeSection);
  }

  // CONTRAINDICATIONS (on-demand)
  if (kbData.contra?.length) {
    let ciSection = 'CLINICAL KB — CONTRAINDICATIONS:\n\n';
    for (const ci of kbData.contra) {
      ciSection += `• ${ci.compound_id} [${ci.contraindication_type}] ${ci.condition_or_population}: ${ci.guidance || ''}\n`;
    }
    sections.push(ciSection);
  }

  // RESEARCH (on-demand)
  if (kbData.research?.length) {
    let rsSection = 'CLINICAL KB — RESEARCH STATUS:\n\n';
    for (const rs of kbData.research) {
      rsSection += `• ${rs.compound_id} — ${rs.study_name} (${rs.study_year || 'N/A'}): ${rs.key_finding?.substring(0, 200) || ''} [${rs.status}]\n`;
    }
    sections.push(rsSection);
  }

  // PHARMACOKINETICS (on-demand)
  if (kbData.pk?.length) {
    let pkSection = 'CLINICAL KB — PHARMACOKINETICS:\n\n';
    for (const p of kbData.pk) {
      pkSection += `• ${p.compound_id} (${p.route}): Bioavailability: ${p.bioavailability || 'N/A'}, Half-life: ${p.half_life || 'N/A'}. ${p.distribution_notes?.substring(0, 200) || ''}\n`;
    }
    sections.push(pkSection);
  }

  if (sections.length === 0) {
    return 'CLINICAL KB: No specific data loaded for this query. Respond using your general cannabis medicine knowledge and the compound reference above.';
  }

  return sections.join('\n');
}
