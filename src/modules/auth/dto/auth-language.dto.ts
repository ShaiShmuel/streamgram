import { IsIn, IsOptional } from "class-validator";
import { SupportedLanguage } from "../../user/instance-profile";

export class AuthLanguageDto {
  @IsOptional()
  @IsIn(["en", "he", "ru", "ar", "es"])
  language?: SupportedLanguage;
}
