//! How many rounds a side may have in the air on a shared field (`shotBudget`, src/construction-limits.js): a gun of a
//! side that has its share up holds its fire, its round unspent and its reload untouched, until some of them come down.
//! However many its side has up, a construction may always have a few rounds of its own in the air, so that a side
//! whose guns fill its share still has guns that fire.
use serde_json::Value;
use std::collections::HashMap;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ShotBudget {
    /// The rounds a side may have in the air.
    pub side: usize,
    /// The rounds of its own a construction may have there, whatever its side has.
    pub own: usize,
}
impl ShotBudget {
    /// Of a field that sets one, `{faction, own}`; a field that sets none holds no gun for it.
    pub fn from_value(v: &Value) -> Option<Self> {
        let count = |key: &str| v[key].as_u64().map(|n| n as usize);
        Some(Self { side: count("faction")?, own: count("own")? })
    }
}
/// The rounds in the air of each side, and of each construction by its handle.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Airborne {
    sides: HashMap<String, usize>,
    own: HashMap<u32, usize>,
}
impl Airborne {
    /// Of the constructions that fired the rounds in the air, each of its side (`side_of`): a round of one no longer on
    /// the field counts for nobody.
    pub fn of<'a>(fired_by: impl Iterator<Item = u32>, side_of: impl Fn(u32) -> Option<&'a str>) -> Self {
        let mut airborne = Self::default();
        for actor in fired_by {
            if let Some(side) = side_of(actor) {
                airborne.launched(side, actor);
            }
        }
        airborne
    }
    /// Whether construction `actor`, of `side`, may put one more round in the air.
    pub fn allows(&self, budget: ShotBudget, side: &str, actor: u32) -> bool {
        self.own.get(&actor).copied().unwrap_or(0) < budget.own || self.sides.get(side).copied().unwrap_or(0) < budget.side
    }
    /// One more round of construction `actor`, of `side`, in the air.
    pub fn launched(&mut self, side: &str, actor: u32) {
        *self.own.entry(actor).or_default() += 1;
        match self.sides.get_mut(side) {
            Some(count) => *count += 1,
            None => {
                self.sides.insert(side.to_string(), 1);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_field_sets_a_budget_or_holds_no_gun() {
        assert_eq!(ShotBudget::from_value(&json!({"faction":1024,"own":4})), Some(ShotBudget { side: 1024, own: 4 }));
        assert_eq!(ShotBudget::from_value(&Value::Null), None);
        assert_eq!(ShotBudget::from_value(&json!({"faction":1024})), None);
    }
    #[test]
    fn a_side_up_to_its_share_still_fires_what_each_construction_has_of_its_own() {
        let budget = ShotBudget { side: 3, own: 1 };
        let sides = |actor: u32| Some(if actor < 10 { "a" } else { "b" });
        let mut up = Airborne::of([1, 1].into_iter(), sides);
        assert!(up.allows(budget, "a", 1), "below the share of its side");
        up.launched("a", 1);
        assert!(!up.allows(budget, "a", 1), "its side has its share up, and it has more than its own");
        assert!(up.allows(budget, "a", 2), "one with none of its own up fires its own");
        up.launched("a", 2);
        assert!(!up.allows(budget, "a", 2));
        assert!(up.allows(budget, "b", 10), "another side has its own share");
        assert_eq!(up, Airborne::of([1, 1, 1, 2].into_iter(), sides), "counted as fired or counted over, the same");
        assert_eq!(Airborne::of([1, 7].into_iter(), |actor| (actor == 1).then_some("a")), Airborne::of([1].into_iter(), sides),
            "a round of a construction no longer on the field is nobody's");
    }
}
