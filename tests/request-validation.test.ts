import { describe, expect, test } from 'bun:test';
import { validateAnalyzeBody, validateLearnBody } from '../lib/request-validation';

describe('analysis request validation', () => {
  test('an empty object is accepted and filled with defaults', () => {
    const { value, errors } = validateAnalyzeBody({});
    expect(errors).toHaveLength(0);
    expect(value!.tradingStyle).toBe('Intraday');
    expect(value!.accountType).toBe('Standard');
    expect(value!.brokerId).toBe('EXNESS');
    expect(value!.userId).toBe('guest');
  });

  test('a non object body is rejected', () => {
    expect(validateAnalyzeBody('not-json-object').value).toBeNull();
    expect(validateAnalyzeBody(null).value).toBeNull();
    expect(validateAnalyzeBody([1, 2, 3]).value).toBeNull();
  });

  test('negative equity is rejected with a readable message', () => {
    const { value, errors } = validateAnalyzeBody({ equity: -5 });
    expect(value).toBeNull();
    expect(errors.join(' ')).toContain('equity');
  });

  test('risk outside nought to one hundred is rejected', () => {
    expect(validateAnalyzeBody({ riskPercentage: 0 }).value).toBeNull();
    expect(validateAnalyzeBody({ riskPercentage: 150 }).value).toBeNull();
    expect(validateAnalyzeBody({ riskPercentage: 2.5 }).value).not.toBeNull();
  });

  test('an unknown trading style is rejected rather than silently defaulted', () => {
    const { value, errors } = validateAnalyzeBody({ tradingStyle: 'Gambling' });
    expect(value).toBeNull();
    expect(errors.join(' ')).toContain('tradingStyle');
  });

  test('an unknown broker is rejected', () => {
    expect(validateAnalyzeBody({ brokerId: 'NOT_A_BROKER' }).value).toBeNull();
  });

  test('a valid full request passes through unchanged', () => {
    const { value } = validateAnalyzeBody({
      equity: 5000,
      riskPercentage: 1,
      tradingStyle: 'Swing',
      accountType: 'Pro',
      brokerId: 'HFM',
      userId: 'abc',
      pastLearningRecords: [],
    });
    expect(value).toEqual({
      equity: 5000,
      riskPercentage: 1,
      tradingStyle: 'Swing',
      accountType: 'Pro',
      brokerId: 'HFM',
      userId: 'abc',
      pastLearningRecords: [],
      minConviction: 0,
      dailyLossLimitPercent: null,
      quickTarget: false,
      skipConvictionBand: null,
      priorWeights: null,
    });
  });
});

describe('learning request validation', () => {
  const goodSetup = {
    id: 'setup_1',
    entryPrice: 4200,
    stopLoss: 4190,
    orderType: 'BUY LIMIT',
    recommendedLotSize: 0.1,
  };

  test('a well formed request is accepted', () => {
    const { value, errors } = validateLearnBody({ setup: goodSetup, outcome: 'TP', closedPrice: 4215 });
    expect(errors).toHaveLength(0);
    expect(value!.outcome).toBe('TP');
    expect(value!.closedPrice).toBe(4215);
  });

  test('a bogus outcome is rejected', () => {
    const { value, errors } = validateLearnBody({ setup: goodSetup, outcome: 'MAYBE', closedPrice: 1 });
    expect(value).toBeNull();
    expect(errors.join(' ')).toContain('outcome');
  });

  test('a missing setup is reported, not thrown', () => {
    const { value, errors } = validateLearnBody({ outcome: 'TP', closedPrice: 100 });
    expect(value).toBeNull();
    expect(errors.join(' ')).toContain('setup');
  });

  // This is the shape that previously produced a 500 leaking an internal
  // "Cannot read properties of undefined" message.
  test('a setup missing its price fields is a 400 style rejection', () => {
    const { value, errors } = validateLearnBody({ setup: { id: 'x' }, outcome: 'TP', closedPrice: 100 });
    expect(value).toBeNull();
    expect(errors.join(' ')).toContain('entryPrice');
  });

  test('a non numeric closing price is rejected', () => {
    expect(validateLearnBody({ setup: goodSetup, outcome: 'SL', closedPrice: 'abc' }).value).toBeNull();
    expect(validateLearnBody({ setup: goodSetup, outcome: 'SL', closedPrice: -3 }).value).toBeNull();
  });
});

describe('an automatically closed order carries why it closed', () => {
  const goodSetup = {
    id: 'setup_1', entryPrice: 4200, stopLoss: 4190,
    orderType: 'BUY LIMIT', recommendedLotSize: 0.1,
  };

  test('the cause and the auto flag pass through', () => {
    const { value } = validateLearnBody({
      setup: goodSetup, outcome: 'MISSED', closedPrice: 4210,
      missCause: 'The validity window closed with price never reaching the entry.',
      autoResolved: true,
    });
    expect(value!.autoResolved).toBe(true);
    expect(value!.missCause).toContain('validity window');
  });

  test('a manual click is not marked as automatic', () => {
    const { value } = validateLearnBody({ setup: goodSetup, outcome: 'MISSED', closedPrice: 4210 });
    expect(value!.autoResolved).toBe(false);
    expect(value!.missCause).toBeUndefined();
  });

  test('an empty cause is treated as absent rather than stored blank', () => {
    const { value } = validateLearnBody({
      setup: goodSetup, outcome: 'MISSED', closedPrice: 4210, missCause: '', autoResolved: true,
    });
    expect(value!.missCause).toBeUndefined();
  });
});

describe('a backtested prior on an analysis request', () => {
  test('a sane prior is carried through', () => {
    const { value } = validateAnalyzeBody({
      equity: 5000,
      priorWeights: {
        orderBlockWeight: 0.4,
        fairValueGapWeight: 0.2,
        liquiditySweepWeight: 0.2,
        newsImpactWeight: 0.1,
        indicatorConfluenceWeight: 0.1,
        atrBufferFactor: 1.6,
        entryBufferPips: 20,
      },
    });
    expect(value?.priorWeights?.atrBufferFactor).toBe(1.6);
    expect(value?.priorWeights?.orderBlockWeight).toBeCloseTo(0.4, 3);
  });

  test('a corrupt prior degrades to the engine defaults rather than failing', () => {
    const { value, errors } = validateAnalyzeBody({ equity: 5000, priorWeights: { atrBufferFactor: 'wide' } });
    expect(errors).toEqual([]);
    expect(value?.priorWeights?.atrBufferFactor).toBe(1.25);
  });

  test('no prior means no prior, not an empty object', () => {
    const { value } = validateAnalyzeBody({ equity: 5000 });
    expect(value?.priorWeights).toBeNull();
    const fromArray = validateAnalyzeBody({ equity: 5000, priorWeights: [] });
    expect(fromArray.value?.priorWeights).toBeNull();
  });
});

describe('the conviction floor on an analysis request', () => {
  test('a floor inside the range is carried through', () => {
    expect(validateAnalyzeBody({ equity: 5000, minConviction: 55 }).value?.minConviction).toBe(55);
  });

  test('no floor means take everything', () => {
    expect(validateAnalyzeBody({ equity: 5000 }).value?.minConviction).toBe(0);
  });

  test('a floor outside zero to one hundred is refused', () => {
    expect(validateAnalyzeBody({ equity: 5000, minConviction: 140 }).errors.join(' ')).toContain(
      'minConviction'
    );
    expect(validateAnalyzeBody({ equity: 5000, minConviction: -5 }).value).toBeNull();
  });
});
