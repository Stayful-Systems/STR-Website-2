/**
 * Batch 24: the first drafts of the knowledge base, for Zac to approve.
 *
 * Written from the three places Stayful Intelligence answered from before
 * Batch 24: the question chips (src/lib/intelligence/answers.ts, Batch 22),
 * the phone agent's service guide (src/lib/voice/agent/service-guide.ts, now deleted,
 * Batch 23) and the site's FAQs (src/lib/faqs-data.ts). Duplicates are
 * merged, every answer is cut to one or two sentences with the figure first,
 * and every figure is a {placeholder}.
 *
 * The seed one-off (runKnowledgeSeed, ?dry=1 first) inserts a missing slug
 * as a draft, and proposes a changed seed text as a draft without touching
 * the live answer. It never approves anything. A later batch that changes a
 * feature, price, limit or rule updates the matching entry here (CLAUDE.md).
 *
 * Pure: no network, no database, no server-only.
 */
import type { EntryContent } from './render.ts';

export interface SeedEntry extends EntryContent {
  slug: string;
  /** Where the text came from, for the reviewer. */
  from: string;
}

export const SEED: readonly SeedEntry[] = [
  // ── The question chips (the Stayful Intelligence view; slugs = CHIP_ORDER) ──
  {
    slug: 'credits',
    from: 'chip credits',
    category: 'credit_billing',
    channels: ['view', 'chat'],
    showWhen: null,
    question: 'How do credits work?',
    variants: ['How much credit do I have?', "What's my balance?", 'What does credit pay for?'],
    answer: 'You have {balance} of credit: it pays for opening deals, daily picks and reports, and top-up credit is spent at {topup_rate} the plan price.',
  },
  {
    slug: 'open_cost',
    from: 'chip open_cost',
    category: 'deals',
    channels: ['view', 'call', 'chat'],
    showWhen: null,
    question: 'What does it cost to open a deal?',
    variants: ['How much is it to open a deal?', 'What does opening a deal cost?', 'Why do some deals cost more to open?'],
    answer: 'Between {open_cost_min} and {open_cost_max} to open a deal, depending on how profitable it is; it comes out of your credit and shows the address and listing.',
  },
  {
    slug: 'pack',
    from: 'chip pack',
    category: 'credit_billing',
    channels: ['view', 'chat'],
    showWhen: 'pack_available',
    question: 'What do I get with the {pack_cost} pack?',
    variants: ['What is the starter pack?', 'Is the starter pack worth it?'],
    // Batch 29: the bonus (the credit beyond the price) covers opening deals, saved reports and daily picks, and expires.
    answer: '{pack_credit} of credit for {pack_cost}, once. The {pack_cost} you pay covers anything and never expires; the {pack_bonus} bonus covers opening deals, saved reports and daily picks for {pack_bonus_days} days.',
  },
  {
    slug: 'save',
    from: 'chip save',
    category: 'alerts',
    channels: ['view', 'chat'],
    showWhen: null,
    question: 'What happens when I save a deal?',
    variants: ['Does saving a deal cost anything?', 'What does keep do?', 'Will you tell me if the price drops?'],
    answer: "Saving is free: it goes to My deals and I'll tell you by {#alerts_by_text}email and text{/alerts_by_text}{^alerts_by_text}email{/alerts_by_text} if the price drops, it's back on the market, it's getting attention or it's gone. A deal I save for you is marked Saved for you and is free to open.",
  },
  {
    slug: 'how_picked',
    from: 'chip how_picked',
    category: 'deals',
    channels: ['view', 'chat'],
    showWhen: null,
    question: 'How do you pick my deals?',
    variants: ['How are my deals chosen?', 'Why did you pick these deals?'],
    answer: '{#tailored}I ranked {checked_count} live deals against your answers: must-haves first, then nice-to-haves, the short-let income check and profit.{/tailored}{^tailored}I ranked {checked_count} live deals in your areas and budget by short-let income and profit.{/tailored}',
  },
  {
    slug: 'analysis',
    from: 'chip analysis',
    category: 'reports',
    channels: ['view', 'chat'],
    showWhen: null,
    question: "What's in a full analysis and a deep report?",
    variants: ['What do I get in a full analysis?', 'What is a deep report?', 'What does PMI add?'],
    // Batch 29: a pack-only member tops up for the second opinion.
    answer: "A full analysis is {full_analysis_cost}{#welcome_offer} ({welcome_cost} on your matches until {welcome_until}){/welcome_offer}: it opens the deal with {forecast_months} months of short-let income, costs, comparables and due-diligence checks. A deep report adds PMI's second opinion for {deep_report_cost}{#first_deep_offer} ({first_deep_cost} your first time){/first_deep_offer}.{#pack_only} With the starter pack, top up to add the second opinion.{/pack_only}",
  },
  {
    slug: 'free_delay',
    from: 'chip free_delay',
    category: 'deals',
    channels: ['view', 'chat'],
    showWhen: 'free_delay_applies',
    question: 'Why do free members see deals later?',
    variants: ['Why are deals delayed for me?', 'Why do I see new deals late?'],
    answer: 'Free members see a new deal {free_delay_hours} hours after it goes live; members who have paid see it straight away.',
  },
  {
    slug: 'calls',
    from: 'chip calls',
    category: 'calls',
    channels: ['view', 'chat'],
    showWhen: null,
    question: 'How do calls from you work?',
    variants: ['What do your calls cost?', 'Will you phone me?'],
    answer: "About {call_minute_cost} a minute from your credit, only if you've said yes: I ring to introduce myself, when your credit runs low, or about a standout deal (at most {standout_calls_per_month} a month). Missed calls are free, texts {text_cost} and emails {email_cost}.{^calls_live} I'm not making calls yet.{/calls_live}",
  },
  {
    slug: 'topup',
    from: 'chip topup',
    category: 'credit_billing',
    channels: ['view', 'chat'],
    showWhen: null,
    question: 'How do I top up or turn on auto top-up?',
    // Review R3 (R3-10): "How do I top up?" on its own ties with auto_topup; as a phrasing here it is answered.
    variants: ['How do I add credit?', 'How do I buy more credit?', 'How do I top up?'],
    answer: 'Top up {topup_amounts} in Account → Billing; auto top-up adds your chosen amount when you drop below your limit and needs a saved card.',
  },
  {
    slug: 'no_match',
    from: 'chip no_match',
    category: 'deals',
    channels: ['view', 'chat'],
    showWhen: 'no_match',
    question: "Why can't you find me anything?",
    variants: ['Why are there no deals for me?', 'Why am I not getting any matches?'],
    answer: '{no_match_line}',
  },

  // ── The phone agent's service guide (calls; most also for the chat) ──
  {
    slug: 'what_it_does',
    from: 'guide.what',
    category: 'how_it_works',
    channels: ['call', 'chat'],
    showWhen: null,
    question: 'What does Stayful Intelligence do?',
    variants: ['What is Stayful Intelligence?', 'What is this service?', 'Who are you?'],
    answer: 'It searches UK short-let deals every day, to buy and rent-to-rent, and picks the ones that fit what you told us you want, with figures from comparables and the properties Stayful runs.',
  },
  {
    slug: 'how_picks_work',
    from: 'guide.picks',
    category: 'deals',
    // The chat answers this from the how_picked chip, which knows the member's own count.
    channels: ['call'],
    showWhen: null,
    question: 'How are deals picked for me?',
    variants: ['How does the matching work?', 'How do I get better matches?'],
    answer: 'Every day the deals that best fit your cash, areas and kind of deal show on Today and in your daily email, and the more you answer and keep or pass, the better they get.',
  },
  {
    slug: 'reports',
    from: 'guide.reports + faq.6',
    category: 'reports',
    channels: ['call'],
    showWhen: null,
    question: 'What does a full analysis cost and include?',
    variants: ['How much is a report?', 'What is in a report?', 'How much does PMI cost?'],
    answer: "A Full analysis is {full_analysis_cost} and gives {forecast_months} months of short-let income, costs, comparables, risks and the local market; with PMI's second opinion it is {deep_report_cost}.",
  },
  {
    slug: 'credit_how',
    from: 'guide.credit',
    category: 'credit_billing',
    channels: ['call'],
    showWhen: null,
    question: 'How does credit work?',
    variants: ['How do I pay?', 'Do I need a subscription?', 'What is my balance?'],
    answer: 'Everything is paid from credit: top up any time or take a plan for monthly credit, and Account → Billing shows what each thing costs. I never say a balance on the phone; it is in the app.',
  },
  {
    slug: 'auto_topup',
    from: 'guide.autotopup',
    category: 'credit_billing',
    channels: ['call', 'chat'],
    showWhen: null,
    question: 'What is auto top-up?',
    variants: ['How do I turn on auto top-up?', 'Can you top me up automatically?'],
    answer: 'The one-tap offer adds {auto_topup_amount} whenever your balance drops below {auto_topup_threshold}, so searches never stop; you can choose other amounts in Account → Billing, and it needs a saved card.',
  },
  {
    slug: 'calls_how',
    from: 'guide.calls',
    category: 'calls',
    channels: ['call'],
    showWhen: null,
    question: 'Why are you calling me, and what does it cost?',
    variants: ['When do you call?', 'How much do calls cost?', 'Do missed calls cost anything?'],
    answer: 'Answered calls cost about {call_minute_cost} a minute and missed calls are free: I only call members who said yes, on {call_days} between {call_hours_start} and {call_hours_end}, to introduce myself, when credit runs low, or about a standout deal (at most {standout_calls_per_month} a month); texts are {text_cost}, emails {email_cost}.',
  },
  // ── Batch 25: standout deals, deal calls, the auto top-up nudge, "I've noticed" ──
  {
    slug: 'standout_calls',
    from: 'batch 25',
    category: 'calls',
    channels: ['call', 'chat'],
    showWhen: null,
    question: 'Why would you call me about a deal?',
    variants: ['Do you call about deals?', 'How often will you call me about deals?', 'What is a standout deal?'],
    answer: "When a deal fits you better than anything I've found so far ({standout_min_match} match or better, well above your minimum profit), I save it to My deals and may ring you about it: at most {standout_calls_per_month} times a month, on {call_days} between {call_hours_start} and {call_hours_end}.",
  },
  {
    slug: 'why_called',
    from: 'batch 25',
    category: 'calls',
    channels: ['call', 'chat'],
    showWhen: null,
    question: 'Why did you call me?',
    variants: ['What was that call about?', 'Why did Stayful Intelligence ring me?', 'You called me, what was it?'],
    answer: "I only ring for three things: to introduce myself once, when your credit is running low, or when a deal fits you better than anything I've found so far. That deal is saved in My deals and opening it is free.",
  },
  // ── Batch 23b's morning briefing (drafted in Review R3, when its ceiling became a setting) ──
  {
    slug: 'morning_briefing',
    from: 'review r3 (the Batch 23b handover)',
    category: 'how_it_works',
    channels: ['view', 'chat'],
    showWhen: null,
    question: 'What is the morning briefing?',
    variants: ['What is the note at the top of my daily email?', 'Does the morning briefing cost anything?', 'Can I hear my briefing?'],
    answer: 'Your daily email and Today open with a short briefing on something in your own figures, never a listing’s words.{#briefings_on} Written by me it costs at most {briefing_max_cost} of credit, after the day’s own charge; the standard line is free.{/briefings_on}{^briefings_on} It is the standard line, free.{/briefings_on} Play on Today reads it out.',
  },
  {
    slug: 'why_not_called',
    from: 'batch 25',
    category: 'calls',
    channels: ['call', 'chat'],
    showWhen: null,
    question: "Why didn't you call me about a deal?",
    variants: ["Why haven't you rung me?", 'I got an email instead of a call', 'Why was a deal just saved and not called about?'],
    answer: "I ring about a standout deal only with calls on and a verified mobile, on {call_days} between {call_hours_start} and {call_hours_end}, once a day and {standout_calls_per_month} times a month at most, with {standout_call_floor} of credit or more. Otherwise it's saved in My deals and in your next daily email.",
  },
  {
    slug: 'saved_for_you',
    from: 'batch 25',
    category: 'deals',
    channels: ['call', 'chat'],
    showWhen: null,
    question: "What does 'Saved for you by Stayful Intelligence' mean?",
    variants: ["Why is there a deal in My deals I didn't save?", 'Who saved this deal?', 'Do I pay to open a deal you saved?', 'How do I remove a deal you saved?'],
    answer: "It's a deal I saved because it fits you better than anything I'd found so far: opening it is free. Not for me takes it off your list and teaches me what you don't want, with a few seconds to undo it.",
  },
  {
    slug: 'auto_topup_nudge',
    from: 'batch 25',
    category: 'credit_billing',
    channels: ['call', 'chat'],
    showWhen: null,
    question: 'Why did you text me about auto top-up?',
    variants: ['Why did I get an auto top-up email?', "I got a message saying I'm down to my last credit"],
    answer: "On pay-as-you-go, when your credit reaches {low_credit_mark} {nudge_days_min} to {nudge_days_max} days after your last top-up, I send one text ({text_cost}) and email ({email_cost}) with a one-tap link: auto top-up adds {auto_topup_amount} whenever you drop below {auto_topup_threshold}, and you can turn it off any time.",
  },
  {
    slug: 'noticed_prompts',
    from: 'batch 25',
    category: 'how_it_works',
    channels: ['call', 'chat'],
    showWhen: null,
    question: "What are the 'I've noticed' questions on Today?",
    variants: ['Why are you asking me to change my profile?', 'Did you change my profile?', "Why did you say you'd noticed something?"],
    answer: "When the deals you keep and pass say something different from your answers, I ask on Today. Nothing changes unless you tap to accept it, and Keep my answer stops me asking about it for a while.",
  },
  {
    slug: 'stop_calls',
    from: 'guide.stop',
    category: 'calls',
    channels: ['call', 'chat'],
    showWhen: null,
    question: 'How do I stop the calls or texts?',
    variants: ['Stop calling me', 'How do I turn off texts?', 'Unsubscribe me'],
    answer: 'Switch calls off in Account → Notifications, or reply STOP to any text; I never change settings on a call, so I point you to the app.',
  },
  {
    slug: 'phone_privacy',
    from: 'guide.privacy',
    category: 'calls',
    channels: ['call'],
    showWhen: null,
    question: "Why won't you tell me my balance or the address?",
    variants: ['Can you read me the address?', 'Can I pay by card on the phone?'],
    answer: "Anyone could ring from a spoofed number, so I never say an address, a balance or a deal's figures on the phone, and I never take card details; they are all in the app.",
  },
  {
    slug: 'talk_to_team',
    from: 'guide.team',
    category: 'account',
    channels: ['call', 'chat'],
    showWhen: null,
    question: 'Can I talk to a person?',
    variants: ['I want a refund', 'Something is not working', 'How do I contact Stayful?'],
    answer: "For anything I can't help with, like billing disputes, refunds or something not working, I pass it to the Stayful team, who reply by email; you can also email {team_email}.",
  },
  {
    slug: 'management',
    from: 'guide.management + faq.8',
    category: 'how_it_works',
    channels: ['call', 'chat'],
    showWhen: null,
    question: "Is this the same as Stayful's management service?",
    variants: ['Can Stayful manage my property?', 'What does Stayful Management cost?'],
    answer: 'No: Stayful Management is a separate full-service offering that runs short-lets for owners at {management_fee}, and most members never use it.',
  },

  // ── The site's FAQs and trust FAQs (calls and the chat) ──
  {
    slug: 'what_it_costs',
    from: 'faq.6',
    category: 'credit_billing',
    channels: ['call', 'chat'],
    showWhen: null,
    question: 'What does it cost?',
    variants: ['How much is Stayful?', 'Is it free?', 'How much is a plan?'],
    answer: 'Every account starts with {welcome_credit} of free credit, about {analyses_in_welcome} Full analyses; after that plans start at {lowest_plan_cost} a month, or top up from {min_topup}, spent at {topup_rate} the plan rate.',
  },
  {
    slug: 'analyser_output',
    from: 'faq.1',
    category: 'reports',
    channels: ['call', 'chat'],
    showWhen: null,
    question: 'What does the Property Analyser actually output?',
    variants: ['What is in the analyser report?', 'What sections are in the report?'],
    // Review R3 (R3-21): no fixed count; a report has the sections its deal needs (up to the most).
    answer: 'A report with live comparables, amenities and demand, a gross-to-net revenue breakdown, a {forecast_months}-month forecast, the local area, a furnishing quote and a risk assessment, every figure sourced: up to {report_sections} sections, depending on the deal.',
  },
  {
    slug: 'data_sources',
    from: 'faq.2',
    category: 'how_it_works',
    channels: ['call', 'chat'],
    showWhen: null,
    question: 'Where does the data come from?',
    variants: ['Where do your figures come from?', 'What data do you use?'],
    answer: 'Airbtics for live Airbnb comparables, PropertyData for long-let values and area data, Google Places for amenities and Ticketmaster for events; every source is named on the figure it produces.',
  },
  {
    slug: 'bold_claims',
    from: 'faq.3 + trust.4',
    category: 'how_it_works',
    channels: ['call', 'chat'],
    showWhen: null,
    question: 'Is this making bold revenue claims?',
    variants: ['Are your income figures realistic?', 'Is this a best-case projection?'],
    answer: 'No: you see what comparable properties in your postcode actually earn, quiet months included, so the figure you take into a decision is one you can defend to a lender.',
  },
  {
    slug: 'vs_competitors',
    from: 'faq.4',
    category: 'how_it_works',
    channels: ['call', 'chat'],
    showWhen: null,
    question: 'How is this different from Airdna or AirROI?',
    variants: ['Why not use Airdna?', 'How do you compare to other tools?'],
    answer: 'Those tools tell you what an area earns; Stayful tells you what to do about a specific property, step by step, to win in its postcode.',
  },
  {
    slug: 'technical',
    from: 'faq.5',
    category: 'how_it_works',
    channels: ['call', 'chat'],
    showWhen: null,
    question: 'Do I need to be technical to use it?',
    variants: ['Is it hard to use?', 'Do I need spreadsheets?'],
    answer: 'No: type an address and click analyse; there is no setup, no configuration and no spreadsheet to build.',
  },
  {
    slug: 'prospective',
    from: 'faq.7',
    category: 'how_it_works',
    channels: ['call', 'chat'],
    showWhen: null,
    question: "Can I use this for properties I don't own yet?",
    variants: ['Can I analyse a property before I buy it?', 'Can I check a deal before making an offer?'],
    answer: "Yes, that's the most common use: investors run deals through the Analyser before making an offer, and the setup costs and risk score are built for that.",
  },
  {
    slug: 'forecast_accuracy',
    from: 'trust.1',
    category: 'how_it_works',
    channels: ['call', 'chat'],
    showWhen: null,
    question: 'How do you know your forecasts are accurate?',
    variants: ['Are your forecasts right?', 'Can I trust the income estimate?'],
    answer: 'We run the properties, so we check: for the {ledger_properties} short-lets Stayful took on in {ledger_year}, the methodology page shows each estimate beside {forecast_months} months of real bookings, a small sample and we say so.',
  },
  {
    slug: 'conflict_of_interest',
    from: 'trust.2',
    category: 'how_it_works',
    channels: ['call', 'chat'],
    showWhen: null,
    question: "Isn't it a conflict of interest that you're also a management company?",
    variants: ['Do you inflate figures to win management?', 'Why should I trust a management company?'],
    answer: "It's a fair question: each estimate is made before we know whether the property will come under management, and we publish the variance either way, including where the model was wrong.",
  },
  {
    slug: 'nightly_rate',
    from: 'trust.3',
    category: 'how_it_works',
    channels: ['chat'],
    showWhen: null,
    question: "Why isn't nightly rate in the forecast-vs-actual table?",
    variants: ['Where is the nightly rate comparison?'],
    answer: 'Our forecast and a host dashboard measure nightly rate on different terms, so we leave it out until we can publish both alike; owner net is measured the same way on both, so the ledger reports that.',
  },
  {
    slug: 'outside_managed_areas',
    from: 'trust.5',
    category: 'how_it_works',
    channels: ['call', 'chat'],
    showWhen: null,
    question: "What happens where you don't manage properties?",
    variants: ['Is the data as good outside your areas?'],
    answer: 'You get the market data every platform has, live comparables, long-let benchmarks and demand drivers, and the report says which figures come from our own properties and which do not.',
  },
  // ── Batch 26: the typed chat (drafts for Zac; every figure a placeholder) ──
  {
    slug: 'chat_what',
    from: 'batch 26',
    category: 'how_it_works',
    channels: ['chat', 'view'],
    showWhen: null,
    question: 'What can I ask you?',
    variants: ['What can you help with?', 'How does the chat work?', 'What do you know about?'],
    // Batch 27: the full view acts too, so this no longer says answers only.
    answer: 'Ask me about your deals, your credit, your search or how Stayful works, or in the full view tell me to do something for you. A quick answer under the eye is about {chat_quick_cost}; the full view, which can look at your own deals and act on them, is about {chat_full_cost}.',
  },
  {
    slug: 'chat_cost',
    from: 'batch 26',
    category: 'credit_billing',
    channels: ['chat', 'view'],
    showWhen: null,
    question: 'How much does a question cost?',
    variants: ['Do questions cost credit?', 'Why was I charged for a question?', 'What does asking you cost?'],
    // Review R3 (R3-30): the figures are plan-credit pence; top-up credit is spent at its rate, so say so.
    answer: 'A quick answer is about {chat_quick_cost} and a full-view answer about {chat_full_cost}: you pay {chat_markup} what the AI actually cost, never more than {chat_quick_max} or {chat_full_max} (top-up credit is spent at {topup_rate} the plan rate), and nothing when I can’t answer. The questions you tap are free.',
  },
  {
    slug: 'chat_full_view',
    from: 'batch 26',
    category: 'how_it_works',
    channels: ['chat'],
    showWhen: null,
    question: 'Why did you say ask in the full view?',
    variants: ['Why can’t the quick box answer that?', 'What is the full view?'],
    answer: 'Quick answers only see your account basics. Questions about your deals, picks or calls need the full view, which can look them up, for about {chat_full_cost}.',
  },
  {
    slug: 'chat_voice',
    from: 'batch 26b',
    category: 'how_it_works',
    channels: ['chat', 'view'],
    showWhen: null,
    question: 'Can I talk to you instead of typing?',
    variants: ['Can I ask out loud?', 'Do you have voice?', 'Why did you answer out loud?', 'Does talking to you cost more?'],
    // Review R3 (R3-1): the price is said, from the row the charge uses; the page shows it under the answer too.
    answer: 'Yes: tap the mic and ask; I answer out loud, listen once more, then wait for a tap. A spoken answer is charged as AI voice on top of the question, about {chat_speak_quick_cost} quick or {chat_speak_full_cost} full, and shows under the answer; nothing if I don’t catch you.',
  },
  {
    slug: 'chat_history',
    from: 'batch 26',
    category: 'account',
    channels: ['chat', 'view'],
    showWhen: null,
    question: 'How long do you keep my chat?',
    variants: ['Can I delete my chat history?', 'Do you store what I ask you?', 'Who sees my questions?'],
    answer: 'I keep your chat for {transcript_days} days and you can delete it from the full view any time. After that your name comes off: the questions stay, unnamed, so I can learn what to answer better.',
  },
  {
    slug: 'chat_no_advice',
    from: 'batch 26',
    category: 'deals',
    channels: ['chat'],
    showWhen: null,
    question: 'Should I buy this deal?',
    variants: ['Would you buy it?', 'Should I make an offer on it?', 'Is this deal worth buying?'],
    answer: 'I can’t tell you whether to buy: I give you the figures, and the full view can show you a deal’s. Get a survey and your own advice before you offer.',
  },
  {
    slug: 'chat_is_ai',
    from: 'batch 26',
    category: 'how_it_works',
    channels: ['chat', 'view'],
    showWhen: null,
    question: 'Are you an AI?',
    variants: ['Am I talking to a bot?', 'Are you a robot?', 'Is this chat a machine?'],
    // Batch 27: says it can act, and report a problem for the member.
    answer: 'I’m Stayful Intelligence, an AI assistant from Stayful, not a person. I answer, and in the full view I do things for you when you ask; questions I can’t answer, and problems you tell me about, go to the Stayful team.',
  },
  // ── Batch 27: Stayful Intelligence acts for the member (drafts for Zac; every figure a placeholder) ──
  {
    slug: 'si_actions_what',
    from: 'batch 27',
    category: 'how_it_works',
    channels: ['chat', 'view'],
    showWhen: null,
    question: 'What can you do for me?',
    variants: ['Can you do things for me?', 'Can you analyse my deals for me?', 'Can you pass deals for me?', 'Can you change my search for me?', 'Can you check a listing link?', 'Can you write to the agent for me?'],
    // Review R4 (R4-08, Zac 19 Nov 2026): what it may change in the search, each with Undo.
    answer: 'In the full view, tell me and I’ll do it: check a listing link, run Full analyses, deep reports or a deep search, Keep, Pass or move your deals, change your search (including your Buying cash, your R2R setup cash, what you’re after from buy to let, or a price ceiling), or draft a message to an agent for you to send. I never pay, top up, change your plan, cancel, delete, share or contact anyone: those stay as buttons for you.',
  },
  {
    // Review R4 (R4-07, R4-08, Zac 19 Nov 2026): a price ceiling only; Buying cash, setup cash and the buy-to-let priority with Undo.
    slug: 'si_actions_criteria',
    from: 'review r4',
    category: 'deals',
    channels: ['chat', 'view'],
    showWhen: null,
    question: 'Can you change my budget or my Buying cash?',
    variants: ['Only show me deals under a price', 'Can you lower my budget?', 'My R2R setup cash has gone up', 'Can you change what I want from buy to let?', 'Will a budget change my Buying cash?'],
    answer: 'Yes, in the full view. Ask for deals under a price and I set that as your price ceiling and nothing else: your Buying cash stays as it is. I can also change your Buying cash, your R2R setup cash and what you’re after from buy to let (money each month, value going up or a bit of both). Each change can be undone for {si_action_undo_hours} hours, and Undo puts back exactly what you had, even no ceiling at all.',
  },
  {
    slug: 'si_actions_cost',
    from: 'batch 27; Review R4 (R4-46, the listing check’s price)',
    category: 'credit_billing',
    channels: ['chat', 'view'],
    showWhen: null,
    question: 'What does it cost when you do something for me?',
    variants: ['Do you charge more than the button?', 'Why was I charged for an action?', 'Is it cheaper to press the button myself?', 'What does it cost to ask you to run an analysis?'],
    answer: 'What the button would charge you, so your own prices apply: a Full analysis is {full_analysis_cost} (plus opening the deal if it isn’t open), a deep report {deep_report_cost}, a deep search up to {deep_search_max_cost} and a listing check about {listing_check_cost}, with the question itself about {chat_full_cost} and top-up credit spent at {topup_rate} the plan rate. Keep, Pass, stage moves, search changes and drafts are free, and nothing that fails is charged.',
  },
  {
    slug: 'si_actions_stop',
    from: 'batch 27',
    category: 'credit_billing',
    channels: ['chat', 'view'],
    showWhen: null,
    question: 'Can I stop you once you’ve started?',
    variants: ['How do I stop an action?', 'Will you ask before spending my credit?', 'What if I didn’t mean it?', 'Why did you ask me to confirm?'],
    // Review R4 (R4-06, Zac 19 Nov 2026): a pack-only member is told up front when the bonus can't pay.
    answer: 'Yes: before anything paid starts I say what it will cost and you have {si_action_stop_seconds} seconds to tap Stop; after that, Stop the rest stops what hasn’t started. I ask first when an instruction would spend more than {si_action_cap} or leave you under {low_credit_mark}, and when you haven’t enough credit nothing runs.{#pack_only} Your starter pack bonus only pays for opening deals, saved reports and daily picks, so for anything else I tell you up front when the credit you paid for isn’t enough, and offer a top-up.{/pack_only}',
  },
  {
    slug: 'si_actions_undo',
    from: 'batch 27',
    category: 'deals',
    channels: ['chat', 'view'],
    showWhen: null,
    question: 'Can I undo what you did?',
    variants: ['You passed the wrong deal', 'Put my search back how it was', 'How do I undo a change you made?', 'Can I get my deals back?'],
    // Review R4 (R4-07, R4-08): Buying cash, setup cash, the buy-to-let priority and a price ceiling are undone exactly.
    answer: 'Keep, Pass, stage moves and changes to your search (your Buying cash, R2R setup cash, what you’re after from buy to let and a price ceiling included) can be undone for {si_action_undo_hours} hours, from the chat or the top of My deals, and Undo puts back exactly what you had; anything you’ve changed since stays as you set it. Undo doesn’t refund analyses, reports, searches or listing checks.',
  },
  {
    slug: 'si_actions_report',
    from: 'batch 27',
    category: 'how_it_works',
    channels: ['chat', 'view'],
    showWhen: null,
    question: 'Can you report a problem for me?',
    variants: ['Something isn’t working', 'How do I report a bug?', 'Can I ask for a new feature?', 'That answer was wrong'],
    answer: 'Yes: tell me what went wrong and I’ll send it to the Stayful team with a reference you’ll see under Your feedback, and that question isn’t charged. For something you’d like us to add, I’ll fill in a request for you to check and send.',
  },
  {
    // Review R4 (R4-45): Batch 27's limits, each a placeholder resolved from its billing_settings row.
    slug: 'si_actions_limits',
    from: 'Batch 27; Review R4 (R4-45)',
    category: 'how_it_works',
    channels: ['chat', 'view'],
    showWhen: null,
    question: 'Is there a limit on what you can do for me?',
    variants: ['How many things can you do for me at once?', 'Why did you say I’ve reached the limit?', 'How many deals can you pass in one go?', 'Why did my request expire?', 'Can I ask you to analyse all my deals?'],
    answer: 'Up to {si_action_rate_per_hour} instructions an hour and {si_action_rate_per_day} a day, each touching at most {si_action_max_targets} deals; past {si_action_cap} I ask before the rest. A confirm or countdown you don’t answer lapses after {si_action_confirm_minutes} minutes, and nothing runs.',
  },
  // ── Batch 28: buy-to-let deals (drafts for Zac; every figure a placeholder, the rules wording is legal copy to check) ──
  {
    slug: 'btl_what',
    from: 'batch 28',
    category: 'deals',
    channels: ['call', 'chat', 'view'],
    showWhen: null,
    question: 'What are buy-to-let deals?',
    variants: ['Do you do buy to let?', 'Do you show long lets to tenants?', 'What is a buy-to-let deal?', 'What does Buy to let mean on a card?'],
    answer: 'Homes to buy and let to long-term tenants, judged on the rent: bought with a {btl_ltv} interest-only buy-to-let mortgage at the typical fixed rate, with every running cost in. Each card shows the cash you put in, what it makes a month and your return as ranges, chosen for what you’re after (income, growth or a bit of both) and the cash you can put in.',
  },
  {
    slug: 'btl_add',
    from: 'batch 28; Review R4 (R4-22, the cash ceiling is the Buying cash), Zac 19 Nov 2026',
    category: 'deals',
    channels: ['chat', 'view'],
    showWhen: null,
    question: 'How do I get buy-to-let deals?',
    variants: ['How do I add Buy to let?', 'Why don’t I see buy-to-let deals?', 'I chose All of them, why no buy to let?', 'Can I turn off buy-to-let deals?'],
    answer: 'Tick Buy to let in your profile’s deal types, then tell me what you’re after; the cash you can put in is the same Buying cash answer as for any purchase. A buy-to-let deal is shown only when the middle of its cash in is no more than the top of your Buying cash, the same limit on Today, Browse, standout deals, the what-ifs and the buy-to-let report. If you chose All of them before buy to let arrived, nothing changed for you: tap Add Buy to let to have them. Untick it any time.',
  },
  {
    slug: 'btl_rent_test',
    from: 'batch 28',
    category: 'deals',
    channels: ['chat', 'view'],
    showWhen: null,
    question: 'What is the lender’s rent test?',
    variants: ['Why did this buy-to-let deal fail?', 'What rent does a lender want?', 'Why isn’t this shown as buy to let?', 'Will a lender lend on this?'],
    answer: 'A buy-to-let lender wants the rent to be {btl_rent_test}. I only show a buy-to-let deal that passes on the middle of its rent range and still breaks even at the low end; the deal page says when it’s tight, and what deposit would pass. Get a mortgage broker’s view before you offer.',
  },
  {
    slug: 'btl_costs',
    from: 'batch 28; Review R4 (R4-24, the analyser uses the saved settings), Zac 19 Nov 2026',
    category: 'deals',
    channels: ['chat', 'view'],
    showWhen: null,
    question: 'What costs are in the buy-to-let figures?',
    variants: ['Do the buy-to-let figures include an agent?', 'Is the cashflow before tax?', 'What about service charge?', 'Why is there an energy upgrade in the cash in?'],
    answer: 'Every figure has {btl_running_costs}, plus a flat’s service charge and ground rent (an estimate when the listing doesn’t say), the Full analysis’s “Buy to let instead?” included. The cash in is the deposit, the tax on a second home and the buying costs; the top end adds {btl_epc_allowance}. All before tax, and an estimate, not advice.',
  },
  {
    slug: 'btl_judged',
    from: 'batch 28; Review R4 (R4-22 the benchmark band, R4-27 the standout bar, R4-28 the notice before Open), Zac 19 Nov 2026',
    category: 'deals',
    channels: ['chat', 'view'],
    showWhen: null,
    question: 'How do you decide a buy-to-let deal is good?',
    variants: ['What is the typical deal in my budget?', 'Why is this buy-to-let deal miles away?', 'What makes a buy-to-let standout?', 'Why did you look further out?'],
    answer: 'I compare it with the typical deal on the market in the cash band that holds the top of your Buying cash, near you, widening the search until there are enough to compare, and say how far I looked. When I had to compare across the UK, or there are only a few deals to compare, the card says so before you open it. Income needs a better return, growth better growth, and a bit of both a fair share of each. It’s a standout only when even its low end is {btl_standout_margin} of the typical deal’s, and it makes more each month at the low end than the buy-to-let deals I’ve already shown you.',
  },
  {
    slug: 'btl_report',
    from: 'batch 28',
    category: 'reports',
    channels: ['chat', 'view'],
    showWhen: null,
    question: 'What is the buy-to-let report?',
    variants: ['What do I get for the buy-to-let report?', 'How much is the buy-to-let report?', 'Is there a PDF of the buy-to-let report?', 'Was I charged for a buy-to-let report that failed?'],
    answer: 'For {btl_report_cost}: a rent valuation, a sale valuation, sold prices nearby, the EPC, flood and planning checks, and the buy-to-let figures with all of it in. You see the price first and it’s charged once, only when the report is made; a deal you revealed in your first days can have a welcome price. It’s on the web, saved in My deals.',
  },

  {
    // Review R4 (R4-45): the Explorer's and the Full analysis's buy-to-let views (Batch 28, R4-24's saved settings).
    slug: 'btl_explorer',
    from: 'Batch 28; Review R4 (R4-24 the saved settings, R4-45)',
    category: 'reports',
    channels: ['chat', 'view'],
    showWhen: null,
    question: 'Can I see buy to let in the analyser or the Market Explorer?',
    variants: ['What is Buy to let instead?', 'Does the Full analysis show buy to let?', 'What is the Buy to let view in the Market Explorer?', 'Does the Explorer show rental yields?', 'Is the buy-to-let section extra?'],
    answer: 'Yes, at no extra charge: a Full analysis has a “Buy to let instead?” section on the same saved settings as the deal cards ({btl_ltv} interest-only, a flat’s service charge and ground rent included), and the Market Explorer has a Buy to let view of districts by yield, growth, price and cash in. Before tax, and an estimate, not advice.',
  },

  // ── Review R4 (R4-26): growth on a buy-to-let card is history (a draft for Zac; no figure) ──
  {
    slug: 'btl_growth_history',
    from: 'Review R4 (R4-26, history, not a forecast), Zac 19 Nov 2026',
    category: 'deals',
    channels: ['chat', 'view'],
    showWhen: null,
    question: 'Is the future value on a buy-to-let card a forecast?',
    variants: ['What does Value in five years mean?', 'Will the price really go up that much?', 'Is the growth figure a prediction?', 'Are the buy-to-let figures before tax?'],
    answer: 'No. The value and the growth are history, not a forecast: what the price would be if the area’s prices kept rising as they have over recent years, with a slower pace as the low end. Prices can fall. The monthly cashflow and the return are before tax. Every card says so under the figure.',
  },

  // ── Batch 30: shorter signup questions (drafts for Zac; every figure a placeholder) ──
  {
    slug: 'quiz_questions',
    from: 'batch 30',
    category: 'account',
    channels: ['chat', 'view'],
    showWhen: null,
    question: 'What do you ask when I sign up?',
    variants: ['How long is the signup quiz?', 'Why do you ask so few questions?', 'What are the profile questions?', 'Do I have to answer everything?'],
    answer: 'Only what each kind of deal needs: what you’re looking for (tick as many as you like), where, the cash you can put in, your minimum profit, how you want deals judged against it, the kind of property and a few about you. I don’t ask your deposit or mortgage rate: I use today’s average and tell you so. Everything after the first few can be answered Not sure, and you can change any answer on your profile.',
  },
  {
    slug: 'profit_end',
    from: 'batch 30',
    category: 'deals',
    channels: ['chat', 'view'],
    showWhen: null,
    question: 'How is my minimum profit judged?',
    variants: ['Why do some deals miss my minimum?', 'What does play it safe mean?', 'Which end of the profit range do you use?', 'Why does a card say low end used?', 'Why are my deals judged on the low end?'],
    // Review R4 (R4-03, R4-04; Zac 19 Nov 2026): older and unanswered members are judged on the low end; new members who haven't answered, the middle.
    answer: 'A deal’s profit is shown as a range, a low end and a top end each month. You choose whether the low end (play it safe), the middle or the top end has to reach your minimum, and I judge every deal’s range that way, including Most you can pay and standout deals. If you joined before the shorter signup questions, or answered the older question about risk, I use the low end until you answer the new one; if you joined since and haven’t answered, I use the middle. The card says which end I used.',
  },
  {
    slug: 'mortgage_rate',
    from: 'batch 30',
    category: 'deals',
    channels: ['chat', 'view'],
    showWhen: null,
    question: 'Which mortgage rate do you use?',
    variants: ['Why does the card say today’s average?', 'How do I change the mortgage rate?', 'Can I use my own rate?', 'Why did my figures change overnight?'],
    answer: 'Unless you’ve set your own, I use today’s average mortgage rate, refreshed every day, so your figures can move a little from one day to the next. Every card says which rate it used; tap change to set your own, and Use today’s average to go back to the daily one.',
  },
  {
    slug: 'buying_cash',
    from: 'batch 30',
    category: 'how_it_works',
    channels: ['chat', 'view'],
    showWhen: null,
    question: 'What does Buying cash cover?',
    variants: ['What counts as the cash I can put in?', 'Does Buying cash include the deposit?', 'How much can I afford with my cash?', 'Why was a deal left out for needing too much cash?'],
    answer: 'Your deposit, stamp duty and furnishing, and for a project the works too. I only show purchases you could fund with it, and tell you roughly the price that covers with a mortgage and with cash. It’s one answer for short-lets, projects and buy to let.',
  },
  {
    slug: 'r2r_setup_cash',
    from: 'batch 30',
    category: 'how_it_works',
    channels: ['chat', 'view'],
    showWhen: null,
    question: 'What does R2R setup cash cover?',
    variants: ['What is the rent-to-rent setup budget?', 'Does the setup figure include the landlord’s deposit?', 'Why is a rent-to-rent deal over my setup budget still shown?', 'How is the setup cost worked out?'],
    // Review R4 (R4-02, Zac 19 Nov 2026): setup cash is a nice-to-have for everyone: it ranks, never hides.
    answer: 'Furniture and getting a rent-to-rent property guest-ready. My setup figure doesn’t include the landlord’s deposit or the first month’s rent. Deals that need more setup than you chose are shown lower down, never left out, unless you make setup a must-have on your profile.',
  },
  {
    // Review R4 (R4-05, Zac 19 Nov 2026): an older member's two minimum profits stay separate.
    slug: 'min_profit_two_figures',
    from: 'review r4',
    category: 'deals',
    channels: ['chat', 'view'],
    showWhen: null,
    question: 'Why do I have two minimum profits?',
    variants: ['Will changing my rent-to-rent minimum change my other minimum?', 'Why did my buying minimum not change?', 'What does Undo put back on my minimum profit?', 'Can I have a different minimum for rent-to-rent?'],
    answer: 'If you joined before the shorter signup questions you may have one minimum for deals you buy and one for rent-to-rent, and they stay separate. When I change one for you, or you use a what-if suggestion, only that one changes, and Undo puts both back exactly as they were. New members give one minimum, used for both.',
  },
  {
    slug: 'home_blocker_card',
    from: 'batch 30',
    category: 'account',
    channels: ['chat', 'view'],
    showWhen: null,
    question: 'Why did Home ask what’s holding me back?',
    variants: ['What is the holding you back question?', 'Can I skip the Home question?', 'What happens if I tap Not now?', 'Where did the biggest thing holding you back question go?'],
    answer: 'It used to be part of the signup. From day {blocker_card_day} after you join I ask once on Home, so I can help with that first. Tap an answer, or Not now and I won’t ask again; you can change it on your profile.',
  },

  // ── Review R4 (R4-45): every figure the service facts give has a draft answer (seed.test.ts checks it) ──
  {
    slug: 'profile_reward',
    from: 'service facts; Review R4 (R4-45)',
    category: 'account',
    channels: ['view', 'chat'],
    showWhen: null,
    question: 'Do I get anything for finishing my profile?',
    variants: ['Is there credit for completing my profile?', 'What is the profile bonus?', 'Why did I get credit for my profile?'],
    answer: 'Yes: a complete profile with real answers earns a one-off {profile_credit} of credit. You can change your answers any time on your profile page.',
  },
  {
    slug: 'saved_profiles',
    from: 'service facts; Review R4 (R4-45)',
    category: 'account',
    channels: ['view', 'chat'],
    showWhen: null,
    question: 'Can I have more than one search profile?',
    variants: ['Can I search for my clients separately?', 'How many profiles can I have?', 'Which profile are my daily picks for?'],
    answer: 'Yes, up to {saved_profiles_max} saved profiles, for example one for each client you source for. The active one decides Today, Browse and the Explorer.',
  },
  {
    slug: 'team_seats',
    from: 'service facts; Review R4 (R4-45)',
    category: 'account',
    channels: ['view', 'chat'],
    showWhen: null,
    question: 'Can I add my team?',
    variants: ['How do I invite a colleague?', 'What does a team seat cost?', 'Can my assistant use my account?'],
    answer: 'Yes: invite colleagues and they use your credit. Each seat costs {team_seat_cost} of your credit every {team_seat_days} days, and team members can’t change anything to do with billing.',
  },
  {
    slug: 'daily_picks_cost',
    from: 'service facts; Review R4 (R4-45)',
    category: 'deals',
    channels: ['view', 'chat'],
    showWhen: null,
    question: 'What do my daily picks cost?',
    variants: ['How much is Today’s 5?', 'Why am I charged every day?', 'Do the daily deals cost anything?'],
    answer: 'Daily deals (Today’s 5) are {daily_deals_cost} a day from your credit, on Today and in your daily email.',
  },
  {
    slug: 'pmi_second_opinion',
    from: 'service facts; Review R4 (R4-45)',
    category: 'reports',
    channels: ['view', 'chat'],
    showWhen: null,
    question: 'What does PMI’s second opinion cost?',
    variants: ['What is PMI’s second opinion?', 'How much is the PMI add-on?', 'Should I add the second opinion?'],
    answer: 'You can add PMI’s second opinion to a Full analysis for {pmi_addon_cost}; with it the report is a deep report at {deep_report_cost}.',
  },
  {
    slug: 'text_alerts',
    from: 'service facts; Review R4 (R4-45)',
    category: 'alerts',
    channels: ['view', 'chat'],
    showWhen: null,
    question: 'Can I get alerts by text?',
    variants: ['How do I get text alerts?', 'How many alert texts will I get?', 'When do alert texts come?', 'Do alert texts cost anything?'],
    answer: 'Yes: verify a UK mobile in Account → Notifications and you get at most an alert text a day and {sms_monthly_cap} a month, between {sms_hours_start} and {sms_hours_end} UK time. Alert texts are free; reply STOP to any text to stop them.',
  },

  // ── Batch 29: the starter pack's bonus, its fresh-report limit, the picks pause and Report ready ──
  {
    slug: 'pack_bonus',
    from: 'Batch 29, section A; Review R4 (R4-14 refund rule, R4-19 trial members), Zac 19 Nov 2026',
    category: 'credit_billing',
    channels: ['view', 'chat'],
    showWhen: 'pack_bonus_held',
    question: 'What can my bonus credit pay for?',
    variants: ['What does the starter pack bonus cover?', 'Why can’t I use my bonus for a report?', 'When does my bonus expire?', 'Why didn’t my bonus pay for this?', 'Why is my bonus restricted again after a refund?'],
    answer: 'You have {bonus_balance} of bonus credit for opening deals, saved reports and daily picks{#pack_bonus_dated} until {bonus_expires}{/pack_bonus_dated}. Fresh reports and second opinions need credit you’ve paid for; once you pay for a top-up or a plan, your bonus stops expiring and works on everything. If that payment is refunded or charged back, the bonus goes back to opening deals, saved reports and daily picks, with its first expiry date ({pack_bonus_days} days from the pack).',
  },
  {
    slug: 'pack_fresh_reports',
    from: 'Batch 29, section B; Review R4 (R4-17, slot back on failure), Zac 19 Nov 2026',
    category: 'reports',
    channels: ['view', 'chat'],
    showWhen: 'pack_only',
    question: 'How many fresh reports can I run with the starter pack?',
    variants: ['Why can’t I run another report?', 'How many reports do I have left?', 'Is there a limit on reports?', 'Does a failed report count towards my limit?'],
    answer: 'With the starter pack you can run {pack_fresh_reports} fresh reports, and you have {fresh_reports_left} left. A report that fails doesn’t count, even if part of it was charged. A report already run on a deal still opens with your bonus credit; top up or start a plan to run more.',
  },
  {
    slug: 'pack_early_offer',
    from: 'Batch 29, section C; Review R4 (R4-15 the offer can come on its own; R4-45 the Home offer), Zac 19 Nov 2026',
    category: 'credit_billing',
    channels: ['view', 'chat'],
    showWhen: 'pack_only',
    question: 'Why did I get a “Keep your bonus” offer?',
    variants: ['What is the keep your bonus email?', 'Why did you email me about starting Starter?', 'Why did I get an email about my bonus?', 'What’s this offer on Home?', 'What is the one-off offer?', 'Why am I being offered a plan?'],
    answer: 'When your balance first gets down to {pack_offer_at}, Home shows you a one-off offer that day: Starter or a top-up, so your bonus stops expiring and works on everything. It also comes once in your morning email, or on its own when there’s no morning email that day; any low-credit email waits until the next day.',
  },
  {
    slug: 'report_ready',
    from: 'Batch 29, section E',
    category: 'reports',
    channels: ['view', 'chat'],
    showWhen: null,
    question: 'What does Report ready mean?',
    variants: ['What is the Report ready badge?', 'Why does a deal say it opens instantly?', 'Is a ready report cheaper?'],
    answer: 'Report ready means a full analysis of that deal was run in the last {analysis_reuse_days} days, so yours opens instantly from it. The price is the same and nothing is shown until you open it.',
  },
  {
    slug: 'picks_paused_away',
    from: 'Batch 29, section D',
    category: 'deals',
    channels: ['view', 'chat'],
    showWhen: 'pack_only',
    question: 'Why did my daily picks stop?',
    variants: ['Why have my picks paused?', 'Why am I not getting daily picks?', 'Where are my daily picks?'],
    answer: 'If you haven’t been in for {pack_pause_days} days, I pause your daily picks so your credit isn’t used. They start again the next time you sign in.',
  },

  // ── Batch 31a: Stayful Academy (drafts for Zac; every figure a placeholder: the months and reminder days from ACADEMY_FACTS, the price from the Pro plan) ──
  {
    slug: 'academy_includes',
    from: 'Batch 31a, Zac section 6 (checkout terms)',
    category: 'credit_billing',
    channels: ['view', 'call', 'chat'],
    showWhen: null,
    question: 'What does the Stayful Academy include?',
    variants: ['Do I get Stayful Intelligence with the Academy?', 'What comes with the Academy?', 'Does the Academy come with Intelligence Pro?'],
    answer: 'The Academy includes {academy_trial_months} months of Stayful Intelligence Pro free, starting when you create your Intelligence account with the email you bought it with. After that it’s {pro_plan_cost} a month on the same card until you cancel.',
  },
  {
    slug: 'academy_trial_end',
    from: 'Batch 31a, Zac section 6 (reminder email)',
    category: 'credit_billing',
    channels: ['view', 'call', 'chat'],
    showWhen: null,
    question: 'When do my Academy months end, and what happens then?',
    variants: ['Will I be charged after my Academy months?', 'When does my Academy trial end?', 'What happens after my Academy months?'],
    answer: 'We email you {academy_reminder_days} days before the first charge with the date and the amount. After that it’s {pro_plan_cost} a month on your card unless you cancel; there’s nothing to do to keep it.',
  },
  {
    slug: 'academy_cancel',
    from: 'Batch 31a, Zac section 6 (account line, reminder email)',
    category: 'credit_billing',
    channels: ['view', 'call', 'chat'],
    showWhen: null,
    question: 'How do I cancel my Academy months or my plan?',
    variants: ['How do I cancel my plan after the Academy?', 'Can I stop the Academy Pro plan before I’m charged?', 'How do I cancel before the first charge?'],
    answer: 'Go to Account → Billing and tap Manage or cancel, or use the link in your reminder email. Cancel before your free months end and you aren’t charged anything.',
  },
  {
    slug: 'academy_no_trial',
    from: 'Batch 31a, Zac section 6 (no-match message)',
    category: 'account',
    channels: ['view', 'call', 'chat'],
    showWhen: null,
    question: 'I bought the Academy but don’t have my free months',
    variants: ['Where are my Academy months?', 'My Academy Pro trial isn’t showing', 'I bought the Academy but I’m not on Pro'],
    answer: 'Use the email you bought the Academy with, or contact us.',
  },
];

/**
 * The phone agent's old knowledge ids (Batch 23: positions in the FAQ lists
 * and the guide's ids) → the slug that replaced each, so a question logged
 * before the switch still counts on Coverage.
 */
export const LEGACY_REFS: Readonly<Record<string, string>> = {
  'guide.what': 'what_it_does',
  'guide.picks': 'how_picks_work',
  'guide.reports': 'reports',
  'guide.credit': 'credit_how',
  'guide.autotopup': 'auto_topup',
  'guide.calls': 'calls_how',
  'guide.stop': 'stop_calls',
  'guide.privacy': 'phone_privacy',
  'guide.team': 'talk_to_team',
  'guide.management': 'management',
  'faq.1': 'analyser_output',
  'faq.2': 'data_sources',
  'faq.3': 'bold_claims',
  'faq.4': 'vs_competitors',
  'faq.5': 'technical',
  'faq.6': 'what_it_costs',
  'faq.7': 'prospective',
  'faq.8': 'management',
  'trust.1': 'forecast_accuracy',
  'trust.2': 'conflict_of_interest',
  'trust.3': 'nightly_rate',
  'trust.4': 'bold_claims',
  'trust.5': 'outside_managed_areas',
};

/** A knowledge_ref as logged ("[slug]", "slug", or an old id) → the slug, or null. */
export function refToSlug(ref: string | null | undefined): string | null {
  if (!ref) return null;
  const r = ref.trim().replace(/^\[|\]$/g, '').trim();
  if (!r) return null;
  return LEGACY_REFS[r] ?? r;
}

/** What the seed knows about an existing row. */
export interface SeedRowState {
  slug: string;
  seedHash: string | null;
  draftState: 'none' | 'pending' | 'rejected';
  draftSource: string | null;
  /** Review R3 (R3-146): a retired entry is never proposed to again. */
  retired?: boolean;
}

export interface SeedPlan {
  /** New slugs: inserted as pending drafts. */
  insert: SeedEntry[];
  /** Seed text changed since it was last seeded: proposed as a draft; the live answer is untouched. */
  propose: SeedEntry[];
  /** Seed text changed but Zac has a draft of his own pending: left alone. */
  skipped: { slug: string; reason: string }[];
  unchanged: string[];
}

/**
 * What a seed run would do. Never approves, never touches a live answer, and
 * never replaces a draft Zac is working on (a pending draft not from the
 * seed). A slug whose seed text is unchanged since it was seeded is left
 * alone, so Zac's own edits are not proposed back at him.
 */
export function planSeed(rows: readonly SeedRowState[], seed: readonly SeedEntry[], hash: (e: SeedEntry) => string): SeedPlan {
  const bySlug = new Map(rows.map((r) => [r.slug, r]));
  const plan: SeedPlan = { insert: [], propose: [], skipped: [], unchanged: [] };
  for (const e of seed) {
    const r = bySlug.get(e.slug);
    if (!r) {
      plan.insert.push(e);
      continue;
    }
    if (r.seedHash === hash(e)) {
      plan.unchanged.push(e.slug);
      continue;
    }
    if (r.retired) {
      plan.skipped.push({ slug: e.slug, reason: 'retired' });
      continue;
    }
    if (r.draftState === 'pending' && r.draftSource !== 'seed') {
      plan.skipped.push({ slug: e.slug, reason: 'a draft of your own is pending' });
      continue;
    }
    plan.propose.push(e);
  }
  return plan;
}
