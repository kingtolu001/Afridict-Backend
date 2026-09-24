import type { MarketTerms } from '../contracts.js';

type SeedMarket={id:string;books:{NGN:string;USDT_BSC:string};terms:MarketTerms;bid:string;ask:string};

const openAt='2026-09-24T00:00:00.000Z';
const jurisdictions=['DZ','AO','BJ','BW','BF','BI','CV','CM','CF','TD','KM','CG','CD','CI','DJ','EG','GQ','ER',
  'SZ','ET','GA','GM','GH','GN','GW','KE','LS','LR','LY','MG','MW','ML','MR','MU','MA','MZ','NA','NE','NG','RW','ST',
  'SN','SC','SL','SO','ZA','SS','SD','TZ','TG','TN','UG','ZM','ZW'];
const policy={classification:'standard' as const,eligibility_policy_ref:'afridict:eligibility-v1',
  exposure_limit_minor:'10000000000',fee_bps:100,settlement_asset_ref:'afridict:multi-currency-v1'};
const liquidity={clob:true as const,amm_enabled:false,rfq_enabled:false,subsidy_limit_minor:'0',inventory_limit_minor:'0',
  loss_limit_minor:'0',max_slippage_bps:100};
const resolution=(criteria:string,primary:{name:string;uri:string},fallback:{name:string;uri:string})=>({criteria,
  timezone:'Africa/Lagos',method:'bonded_proposal' as const,primary_source:primary,fallback_sources:[fallback],
  correction_rule:'Use the latest correction published by the primary source before the challenge window closes.',
  cancellation_rule:'Cancel only if neither approved source publishes an unambiguous result by the resolution deadline.',
  invalid_rule:'Apply the approved invalid-market payout policy when the stated observation cannot be determined.',
  challenge_window_seconds:86400,timelock_seconds:3600,panel_size:3,adjudication_threshold:2,
  adjudicator_policy_ref:'afridict:adjudication-v1',bond_policy_ref:'afridict:bond-v1',payout_policy_ref:'afridict:payout-v1'});
const ids=(market:number)=>({id:`00000000-0000-4000-8000-${market.toString().padStart(12,'0')}`,
  books:{NGN:`00000000-0000-4000-8000-${(market+100).toString().padStart(12,'0')}`,
    USDT_BSC:`00000000-0000-4000-8000-${(market+200).toString().padStart(12,'0')}`}});

export const currentEventMarkets:SeedMarket[]=[
  {...ids(301),bid:'450000',ask:'550000',terms:{question:'Will Nigeria qualify for the 2027 Africa Cup of Nations?',
    market_type:'binary',template_id:'event-binary',template_version:1,outcomes:[{id:'yes',label:'Yes'},{id:'no',label:'No'}],
    category:'sports',jurisdictions,open_at:openAt,trading_cutoff:'2027-03-21T23:00:00.000Z',
    expected_event_at:'2027-03-30T22:00:00.000Z',resolution_deadline:'2027-04-03T22:00:00.000Z',
    resolution:resolution('Resolve Yes if CAF records Nigeria as qualified for AFCON 2027 after Group L is complete; otherwise resolve No.',
      {name:'CAF AFCON 2027 qualification',uri:'https://www.cafonline.com/afcon2025/news/the-road-to-east-africa-mapped-out-the-qualifier-draw-for-the-totalenergies-caf-africa-cup-of-nations-pamoja-2027-concluded/'},
      {name:'CAF AFCON 2027 fixtures',uri:'https://www.cafonline.com/afcon2025/news/totalenergies-caf-afcon-pamoja-2027-md-1-2-qualifiers-fixtures-kick-off-times-and-venues/'}),risk:policy,liquidity}},
  {...ids(302),bid:'40000',ask:'60000',terms:{question:'Which club will win the 2026/27 Nigeria Premier Football League?',
    market_type:'categorical',template_id:'event-categorical',template_version:1,outcomes:[
      ['barau','Barau FC'],['rangers','Rangers International FC'],['doma','Doma United FC'],['bendel','Bendel Insurance FC'],
      ['kano_pillars','Kano Pillars FC'],['plateau','Plateau United FC'],['rivers','Rivers United FC'],['kwara','Kwara United FC'],
      ['shooting_stars','Shooting Stars Sports Club'],['ranchers_bees','Ranchers Bees'],['sporting_lagos','Sporting Lagos FC'],
      ['ikorodu_city','Ikorodu City FC'],['niger_tornadoes','Niger Tornadoes FC'],['abia_warriors','Abia Warriors FC'],
      ['warri_wolves','Warri Wolves'],['nasarawa','Nasarawa United FC'],['inter_lagos','Inter Lagos'],
      ['katsina','Katsina United FC'],['kun_khalifat','Kun Khalifat FC'],['enyimba','Enyimba FC']
    ].map(([id,label])=>({id:id!,label:label!})),category:'football',jurisdictions,open_at:openAt,
    trading_cutoff:'2027-04-30T15:00:00.000Z',expected_event_at:'2027-05-31T20:00:00.000Z',
    resolution_deadline:'2027-06-05T20:00:00.000Z',resolution:resolution(
      'Resolve to the club recorded as 2026/27 NPFL champion in the final official league table after all sanctioned adjustments.',
      {name:'NPFL official league table',uri:'https://npfl.com.ng/league/nigeria-premier-football-league/'},
      {name:'NPFL fixtures and results',uri:'https://npfl.com.ng/fixtures-results/'}),risk:policy,liquidity}},
  {...ids(303),bid:'180000',ask:'220000',terms:{question:"Which party's candidate will INEC declare winner of Nigeria's 2027 presidential election?",
    market_type:'categorical',template_id:'event-categorical',template_version:1,outcomes:[{id:'apc',label:'APC'},
      {id:'pdp',label:'PDP'},{id:'lp',label:'Labour Party'},{id:'adc',label:'ADC'},{id:'other',label:'Another party'}],
    category:'politics',jurisdictions,open_at:openAt,trading_cutoff:'2027-01-15T12:00:00.000Z',
    expected_event_at:'2027-01-16T22:00:00.000Z',resolution_deadline:'2027-02-15T22:00:00.000Z',resolution:resolution(
      'Resolve to the political party of the candidate declared winner of the 2027 presidential election by INEC. Any party not separately listed resolves as Another party.',
      {name:'INEC official election information',uri:'https://inecnigeria.org/'},
      {name:'INEC 2027 election timetable',uri:'https://www.inecnigeria.org/wp-content/uploads/2027-GENERAL-ELECTION-TIMETABLE.pdf'}),risk:policy,liquidity}},
  {...ids(304),bid:'300000',ask:'370000',terms:{question:'How will the CBN change the Monetary Policy Rate at its first decision after 24 September 2026?',
    market_type:'categorical',template_id:'event-categorical',template_version:1,outcomes:[{id:'lower',label:'Lower it'},
      {id:'unchanged',label:'Leave it unchanged'},{id:'higher',label:'Raise it'}],category:'economy',jurisdictions,
    open_at:openAt,trading_cutoff:'2026-10-31T23:00:00.000Z',expected_event_at:'2026-12-31T23:00:00.000Z',
    resolution_deadline:'2027-01-05T23:00:00.000Z',resolution:resolution(
      'Compare the MPR in the first CBN MPC decision published after 24 September 2026 with the preceding official rate and resolve Lower it, Leave it unchanged, or Raise it.',
      {name:'CBN monetary policy decisions',uri:'https://www.cbn.gov.ng/MonetaryPolicy/decisions.html'},
      {name:'CBN press releases',uri:'https://www.cbn.gov.ng/Documents/pressreleases.html'}),risk:policy,liquidity}},
  {...ids(305),bid:'450000',ask:'550000',terms:{question:'What all-items year-on-year inflation rate will NBS report for Nigeria for September 2026?',
    market_type:'scalar',template_id:'event-scalar',template_version:1,outcomes:[{id:'short',label:'Lower'},
      {id:'long',label:'Higher'}],scalar_range:{lower:'0',upper:'10000',decimals:2,unit:'percent'},category:'inflation',
    jurisdictions,open_at:openAt,trading_cutoff:'2026-10-10T23:00:00.000Z',expected_event_at:'2026-10-15T23:00:00.000Z',
    resolution_deadline:'2026-10-20T23:00:00.000Z',resolution:resolution(
      'Use the national all-items year-on-year inflation percentage for September 2026 in the NBS CPI report, scaled to two decimal places.',
      {name:'NBS consumer price index reports',uri:'https://microdata.nigerianstat.gov.ng/index.php/catalog/154/related-materials'},
      {name:'National Bureau of Statistics',uri:'https://www.nigerianstat.gov.ng/'}),risk:policy,liquidity}},
  {...ids(306),bid:'450000',ask:'550000',terms:{question:'What average daily crude oil and condensate production will NUPRC report for September 2026?',
    market_type:'scalar',template_id:'event-scalar',template_version:1,outcomes:[{id:'short',label:'Lower'},
      {id:'long',label:'Higher'}],scalar_range:{lower:'0',upper:'3000',decimals:3,unit:'million barrels per day'},
    category:'energy',jurisdictions,open_at:openAt,trading_cutoff:'2026-10-31T23:00:00.000Z',
    expected_event_at:'2026-11-30T23:00:00.000Z',resolution_deadline:'2026-12-05T23:00:00.000Z',resolution:resolution(
      'Use NUPRC total crude oil plus condensate production for September 2026 divided by the number of days in the month, expressed in million barrels per day to three decimals.',
      {name:'NUPRC 2026 production report',uri:'https://www.nuprc.gov.ng/wp-content/uploads/2026/02/JAN-TO-DEC-2026-PRODUCTION.pdf'},
      {name:'NUPRC production news',uri:'https://www.nuprc.gov.ng/media/news/f89a978eca733d8947ae6c48'}),risk:policy,liquidity}},
  {...ids(307),bid:'450000',ask:'550000',terms:{question:'Where will the NGX All-Share Index close on the final trading day of 2026?',
    market_type:'scalar',template_id:'event-scalar',template_version:1,outcomes:[{id:'short',label:'Lower'},
      {id:'long',label:'Higher'}],scalar_range:{lower:'0',upper:'50000000',decimals:2,unit:'index points'},
    category:'markets',jurisdictions,open_at:openAt,trading_cutoff:'2026-12-30T12:00:00.000Z',
    expected_event_at:'2026-12-31T17:00:00.000Z',resolution_deadline:'2027-01-07T17:00:00.000Z',resolution:resolution(
      'Use the NGX Daily Official List closing All-Share Index for the final exchange trading session in calendar year 2026, scaled to two decimals.',
      {name:'NGX official data library',uri:'https://ngxgroup.com/exchange/data/data-library/'},
      {name:'NGX market data documentation',uri:'https://marketdataapiv3.ngxgroup.com/portal/Home/Documentation'}),risk:policy,liquidity}},
  {...ids(308),bid:'450000',ask:'550000',terms:{question:'Will NCC report at least 130 million broadband subscriptions for September 2026?',
    market_type:'binary',template_id:'event-binary',template_version:1,outcomes:[{id:'yes',label:'Yes'},{id:'no',label:'No'}],
    category:'technology',jurisdictions,open_at:openAt,trading_cutoff:'2026-10-15T23:00:00.000Z',
    expected_event_at:'2026-11-30T23:00:00.000Z',resolution_deadline:'2026-12-07T23:00:00.000Z',resolution:resolution(
      'Resolve Yes if the NCC industry statistics table reports 130,000,000 or more broadband subscriptions for September 2026; otherwise resolve No.',
      {name:'NCC industry statistics',uri:'https://ncc.gov.ng/market-data-reports/industry-statistics'},
      {name:'NCC internet service operator data',uri:'https://ncc.gov.ng/internet-service-operator-data'}),risk:policy,liquidity}},
];

export const currentEventSources=[...new Map(currentEventMarkets.flatMap(market=>[market.terms.resolution.primary_source,
  ...market.terms.resolution.fallback_sources]).map(source=>[`${source.name}|${source.uri}`,source])).values()];
export const currentEventCategories=[...new Set(currentEventMarkets.map(market=>market.terms.category))];
export const currentEventJurisdictions=jurisdictions;
