import type {
	BoardGenerationValidationError,
	BoardGenerationValidationInputType,
} from "$lib/board/board-generation";
import type { Locale } from "$lib/i18n/locale";
import { m } from "$lib/paraglide/messages.js";

function inputLabel(
	inputType: BoardGenerationValidationInputType,
	plural: boolean,
	locale: Locale,
): string {
	if (plural) {
		switch (inputType) {
			case "text":
				return m.board_validation_input_text_plural({}, { locale });
			case "image":
				return m.board_validation_input_image_plural({}, { locale });
			case "video":
				return m.board_validation_input_video_plural({}, { locale });
			case "audio":
				return m.board_validation_input_audio_plural({}, { locale });
		}
	}
	switch (inputType) {
		case "text":
			return m.board_validation_input_text({}, { locale });
		case "image":
			return m.board_validation_input_image({}, { locale });
		case "video":
			return m.board_validation_input_video({}, { locale });
		case "audio":
			return m.board_validation_input_audio({}, { locale });
	}
}

export function formatBoardGenerationValidationError(
	error: BoardGenerationValidationError,
	locale: Locale,
): string {
	switch (error.code) {
		case "model_required":
			return m.board_validation_model_required({}, { locale });
		case "audio_reference_required":
			return m.board_validation_audio_reference_required(
				{ model: error.model },
				{ locale },
			);
		case "metadata_required":
			return m.board_validation_metadata_required(
				{ model: error.model },
				{ locale },
			);
		case "references_unsupported":
			return m.board_validation_references_unsupported(
				{ model: error.model },
				{ locale },
			);
		case "text_unsupported":
			return m.board_validation_text_unsupported(
				{ model: error.model },
				{ locale },
			);
		case "input_required":
			return m.board_validation_input_required(
				{
					model: error.model,
					input: inputLabel(error.inputType, false, locale),
				},
				{ locale },
			);
		case "input_minimum":
			return m.board_validation_input_minimum(
				{
					model: error.model,
					min: error.min,
					input: inputLabel(error.inputType, true, locale),
				},
				{ locale },
			);
		case "input_maximum":
			return m.board_validation_input_maximum(
				{
					model: error.model,
					max: error.max,
					input: inputLabel(error.inputType, true, locale),
				},
				{ locale },
			);
		case "reference_role_required":
			return m.board_validation_reference_role_required(
				{ input: inputLabel(error.inputType, true, locale) },
				{ locale },
			);
		case "reference_role_invalid":
			return m.board_validation_reference_role_invalid(
				{ input: inputLabel(error.inputType, true, locale) },
				{ locale },
			);
		case "prompt_minimum_characters":
			return m.board_validation_prompt_minimum_characters(
				{ model: error.model, min: error.min },
				{ locale },
			);
		case "input_missing":
			return m.board_validation_input_missing({}, { locale });
		case "parameter_required":
			return m.board_validation_parameter_required(
				{ parameter: error.parameter },
				{ locale },
			);
		case "parameter_text_required":
			return m.board_validation_parameter_text_required(
				{ parameter: error.parameter },
				{ locale },
			);
		case "parameter_option_invalid":
			return m.board_validation_parameter_option_invalid(
				{ parameter: error.parameter },
				{ locale },
			);
		case "parameter_dimensions_format":
			return m.board_validation_parameter_dimensions_format(
				{
					parameter: error.parameter,
					separator: error.separator,
				},
				{ locale },
			);
		case "parameter_minimum":
			return m.board_validation_parameter_minimum(
				{ parameter: error.parameter, min: error.min },
				{ locale },
			);
		case "parameter_maximum":
			return m.board_validation_parameter_maximum(
				{ parameter: error.parameter, max: error.max },
				{ locale },
			);
		case "parameter_multiple":
			return m.board_validation_parameter_multiple(
				{
					parameter: error.parameter,
					multipleOf: error.multipleOf,
				},
				{ locale },
			);
		case "parameter_boolean_required":
			return m.board_validation_parameter_boolean_required(
				{ parameter: error.parameter },
				{ locale },
			);
		case "parameter_number_invalid":
			return m.board_validation_parameter_number_invalid(
				{
					parameter: error.parameter,
					valueType:
						error.valueType === "integer"
							? m.board_validation_integer({}, { locale })
							: m.board_validation_number({}, { locale }),
				},
				{ locale },
			);
	}
}
