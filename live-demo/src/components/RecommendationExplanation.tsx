import type { RecommendationExplanation as Explanation } from "../recommendationExplanation";
import bobLogo from "../assets/ibm-bob.webp";

export default function RecommendationExplanation({ explanation }: { explanation: Explanation }) {
  return (
    <details className="recommendation-explanation">
      <summary>
        <span className="explanation-info" aria-hidden="true">i</span>
        <span className="explanation-title">Why this recommendation?</span>
        <span className="bob-development-badge" title="Recommendation explanation developed and tested with IBM Bob">
          <img src={bobLogo} alt="" width="28" height="28" />
          <span>IBM Bob</span>
        </span>
        <span className="explanation-chevron" aria-hidden="true">⌄</span>
      </summary>
      <div className="explanation-body">
        <p>{explanation.summary}</p>
        <h4>Detection evidence</h4>
        <ul>{explanation.signals.map((signal) => <li key={signal}>{signal}</li>)}</ul>
        <h4>What this cannot establish</h4>
        <p>{explanation.limitation}</p>
        <p className="explanation-source">{explanation.source}</p>
        <p className="explanation-privacy">These detection details are assembled on this device; opening this panel sends no additional request.</p>
        <p className="explanation-attribution">Recommendation explanation feature developed and tested with IBM Bob.</p>
      </div>
    </details>
  );
}
